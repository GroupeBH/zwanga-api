jest.mock('./bounded-firebase-send', () => ({ sendBoundedFirebase: (app: unknown, message: unknown) => require('firebase-admin/messaging').getMessaging(app).send(message) }));
jest.mock('firebase-admin/messaging', () => ({ getMessaging: jest.fn() }));
import { getMessaging } from 'firebase-admin/messaging';
import { NotificationService } from './notifications.service';
import { Notification } from './entities/notification.entity';
import { androidDriverBackup, androidDriverBackupTtl } from './android-driver-backup';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const item = (type = 'trip_request_nearby') => ({
  id: uuid(1), userId: uuid(2), createdAt: new Date(), title: 'Zwanga', body: 'Trajet de test',
  data: { notificationId: uuid(1), type, driverId: uuid(2), passengerId: uuid(3), tripRequestId: uuid(4),
    ...(type === 'new_booking' ? { bookingId: uuid(5) } : { offerId: uuid(6),
      expiresAt: new Date(Date.now() + 40_000).toISOString(), alertExpiresAt: new Date(Date.now() + 40_000).toISOString() }),
    ringAlert: 'nearby-request-v1', rideArrival: 'Destination de test', ridePricePerSeat: '2500', ridePriceKind: 'budget' },
}) as Notification;
function service(version: number) {
  return Object.assign(Object.create(NotificationService.prototype), {
    firebaseApp: {}, configService: { get: () => 'true' },
    notificationRepository: { manager: { query: jest.fn().mockResolvedValue(version ? [{ version }] : []) } },
  }) as any;
}

describe('backend-first ride notification compatibility', () => {
  afterEach(() => jest.restoreAllMocks());
  it('keys a scheduled safety card by request, even when a sequential offer ID is also present', () => {
    const n = item();
    const push = androidDriverBackup(n, n.data!);
    expect(push.tag).toBe(`ride-backup-nearby-${n.data!.tripRequestId}`);
    expect(JSON.parse(push.body).fallbackTag).toBe(push.tag);
    expect(push.offerId).toBe(n.data!.offerId);
  });
  it.each(['trip_request_nearby', 'driver_dispatch_offer'])('bounds %s transport expiry by its response window', type => {
    const n = item(type), now = Date.now();
    n.data!.expiresAt = new Date(now + 40_000).toISOString();
    n.data!.alertExpiresAt = new Date(now + 15_000).toISOString();
    expect(androidDriverBackupTtl(n, now)).toBe(15_000);
    expect(androidDriverBackupTtl(n, now + 20_000)).toBe(1);
  });
  it('keeps the existing five-minute silent fallback for bookings without a business expiry', () => {
    expect(androidDriverBackupTtl(item('new_booking'))).toBe(300_000);
  });
  it.each([0, 1, 2, 3, 4, 5, 6])('preserves the declared capability v%s for scheduled requests', async version => {
    const send = jest.fn().mockResolvedValue('provider-accepted');
    (getMessaging as jest.Mock).mockReturnValue({ send });
    const n = item();
    await service(version).sendFirebaseNotification(n, 'synthetic-token');
    const push = send.mock.calls[0][0];
    expect(push.data).toMatchObject({ type: 'trip_request_nearby', tripRequestId: uuid(4), offerId: uuid(6),
      driverId: uuid(2), passengerId: uuid(3), alertExpiresAt: n.data!.alertExpiresAt });
    if (version === 5) {
      expect(push.apns.payload.aps.category).toBe('driver-nearby-v1');
      expect(push.apns.payload.aps.sound).toBe('driver_ring.wav');
    } else {
      expect(push.android.priority).toBe('high');
      expect(push.android.ttl).toBeLessThanOrEqual(40_000);
      expect(push.android.ttl).toBeGreaterThan(0);
    }
    if (version === 6) expect(push.data.nativeAlert).toBe('driver-v6');
    else expect(push.data.nativeAlert).toBeUndefined();
    if ([3, 4, 5, 6].includes(version)) expect(push.data.delivery).toBe('driver-phone-v3');
    if ([0, 1, 2].includes(version)) {
      expect(push.notification.title.replace(/[\u202f\u00a0]/g, ' ')).toBe('Zwanga · Budget : 2 500 FC / place');
      expect(push.notification.body).toContain('Destination de test');
    }
    // Scheduled commands still open their detail; never authorize quick instant-dispatch acceptance.
    expect(push.data.actionProtocol).toBeUndefined();
  });
  it.each([2, 3, 4, 5, 6])('retains existing booking actions for v%s', async version => {
    const send = jest.fn().mockResolvedValue('provider-accepted');
    (getMessaging as jest.Mock).mockReturnValue({ send });
    await service(version).sendFirebaseNotification(item('new_booking'), 'synthetic-token');
    expect(send.mock.calls[0][0].data).toMatchObject({ type: 'new_booking', bookingId: uuid(5), actionProtocol: 'driver-v1' });
  });
  it.each([2, 3, 4, 5, 6])('retains existing instant-dispatch actions for v%s', async version => {
    const send = jest.fn().mockResolvedValue('provider-accepted');
    (getMessaging as jest.Mock).mockReturnValue({ send });
    await service(version).sendFirebaseNotification(item('driver_dispatch_offer'), 'synthetic-token');
    expect(send.mock.calls[0][0].data).toMatchObject({ type: 'driver_dispatch_offer', offerId: uuid(6), actionProtocol: 'driver-v1' });
  });
  it.each([0, 2])('retains Expo/APNs delivery without forcing Firebase for v%s', async version => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true,
      json: async () => ({ data: { status: 'ok', id: 'synthetic-expo-ticket' } }),
    } as Response);
    await service(version).sendExpoPushNotification(item(), 'ExponentPushToken[synthetic]');
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.data.type).toBe('trip_request_nearby');
    expect(body.ttl).toBeLessThanOrEqual(40);
    if (version === 2) {
      expect(body.sound).toBe('driver_ring.wav');
    }
    // Legacy Expo nearby alerts have no native decision protocol. Adding a
    // category alone would show Refuser without executing the refusal.
    expect(body.categoryId).toBeUndefined();
  });
});
