jest.mock('./bounded-firebase-send', () => ({ sendBoundedFirebase: (app: unknown, message: unknown) => require('firebase-admin/messaging').getMessaging(app).send(message) }));
import { getMessaging } from 'firebase-admin/messaging';
import { NotificationService } from './notifications.service';
import { Notification, NotificationStatus } from './entities/notification.entity';
import { isRideResponseDeliverable } from './ride-response-delivery';
import { androidDriverBackup } from './android-driver-backup';
import { RideResponseOutbox1780000084000 } from '../database/migrations/1780000084000-RideResponseOutbox';

jest.mock('firebase-admin/messaging', () => ({ getMessaging: jest.fn() }));
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const notification = (type: string) => ({
  id: uuid(1), userId: uuid(2), status: NotificationStatus.PENDING,
  createdAt: new Date(Date.now() - 121_000), title: 'Test', body: 'Test',
  data: { type, driverId: uuid(2), passengerId: uuid(3), offerId: uuid(4),
    tripRequestId: uuid(5), bookingId: uuid(6), ringAlert: 'nearby-request-v1',
    expiresAt: new Date(Date.now() - 90_000).toISOString() },
}) as Notification;

describe('v4 Android native safety card', () => {
  it.each(['new_booking', 'trip_request_nearby', 'driver_dispatch_offer'])('%s keeps both the Expo body and headless protocol', async type => {
    const send = jest.fn().mockResolvedValue('synthetic-message');
    (getMessaging as jest.Mock).mockReturnValue({ send });
    const service: any = Object.assign(Object.create(NotificationService.prototype), {
      firebaseApp: {}, configService: { get: () => 'true' },
      notificationRepository: { manager: { query: jest.fn().mockResolvedValue([{ version: 4 }]) } },
    });
    const item = notification(type);
    item.data!.expiresAt = new Date(Date.now() + 20_000).toISOString();
    await service.sendFirebaseNotification(item, 'synthetic-token');
    const payload = send.mock.calls[0][0];
    expect(payload.notification).toBeUndefined();
    expect(payload.android.priority).toBe('high');
    expect(payload.data).toMatchObject({ title: expect.any(String), message: expect.any(String),
      channelId: 'driver-alert-backup-v1', sound: 'none', alertDelivery: 'native-backup-v4' });
    expect(JSON.parse(payload.data.body)).toMatchObject({ type, driverId: uuid(2), passengerId: uuid(3) });
    expect(JSON.parse(payload.data.body).fallbackTag).toBe(payload.data.tag);
    expect(payload.android.ttl).toBeLessThanOrEqual(type === 'driver_dispatch_offer' ? 20_000 : 300_000);
    expect(payload.android.ttl).toBeGreaterThan(type === 'driver_dispatch_offer' ? 0 : 30_000);
    expect(Buffer.byteLength(JSON.stringify(payload.data), 'utf8')).toBeLessThan(4096);
  });

  it('bounds optional prose without dropping recipient, price or shared-ride consent', () => {
    const item = notification('trip_request_nearby');
    const payload = androidDriverBackup(item, { ...item.data, invitationText: 'é'.repeat(9000),
      rideArrival: 'é'.repeat(9000), rideDeparture: 'é'.repeat(9000), unknownBlob: 'x'.repeat(9000),
      notificationId: uuid(1), sharedTrip: true, existingTripId: uuid(7), ridePricePerSeat: '2500', ridePriceKind: 'budget' });
    expect(Buffer.byteLength(JSON.stringify(payload), 'utf8')).toBeLessThan(4096);
    expect(JSON.parse(payload.body)).toMatchObject({ passengerId: uuid(3), driverId: uuid(2),
      notificationId: uuid(1), sharedTrip: true, existingTripId: uuid(7), ridePricePerSeat: '2500' });
    expect(payload).not.toHaveProperty('unknownBlob');
  });
});

describe('immutable incoming deadlines', () => {
  it.each(['new_booking', 'trip_request_nearby'])('a %s delivered after 45 seconds retains a positive sound window', type => {
    const service: any = Object.create(NotificationService.prototype);
    const item = notification(type); item.createdAt = new Date(Date.now() - 45_000);
    delete item.data!.expiresAt;
    const first = service.driverRingUntil(item);
    expect(Date.parse(first) - Date.now()).toBeGreaterThan(10_000);
    expect(Date.parse(first) - item.createdAt.getTime()).toBe(60_000);
    expect(service.driverRingUntil(item)).toBe(first);
  });
  it('a business expiry still caps the longer sound window', () => {
    const service: any = Object.create(NotificationService.prototype);
    const item = notification('driver_dispatch_offer'); item.createdAt = new Date();
    item.data!.expiresAt = new Date(Date.now() + 5000).toISOString();
    expect(service.driverRingUntil(item)).toBe(item.data!.expiresAt);
  });
  it('a retry cannot restart the sound budget of the same booking notification', () => {
    const service: any = Object.create(NotificationService.prototype);
    const item = notification('new_booking');
    delete item.data!.expiresAt;
    expect(service.driverRingUntil(item)).toBe(new Date(item.createdAt.getTime() + 60_000).toISOString());
    expect(Date.parse(service.driverRingUntil(item))).toBeLessThan(Date.now());
  });
  it('rejects a delayed dispatch notification without renewing its deadline', async () => {
    const item = notification('driver_dispatch_offer');
    const expiry = item.data!.expiresAt;
    const query = jest.fn().mockResolvedValue([]);
    const service: any = Object.assign(Object.create(NotificationService.prototype), {
      configService: { get: () => 'true' }, notificationRepository: { manager: { query } },
    });
    expect(await service.isCriticalNotificationStillDeliverable(item)).toBe(false);
    expect(item.data!.expiresAt).toBe(expiry);
    expect(query.mock.calls.every(([sql]) => !/UPDATE|INSERT/i.test(sql))).toBe(true);
  });
});

describe('current passenger decision checked before queued response', () => {
  it.each(['accepted', 'rejected'])('checks recipient, current %s booking and unfinished trip', async status => {
    const query = jest.fn().mockResolvedValue([{}]);
    const item = notification('booking_response'); item.data!.status = status;
    expect(await isRideResponseDeliverable({ query } as any, item)).toBe(true);
    expect(query.mock.calls[0][1]).toEqual([uuid(6), uuid(2), status]);
    expect(query.mock.calls[0][0]).toContain('b.status = $3');
    expect(query.mock.calls[0][0]).toContain("t.status IN ('upcoming', 'ongoing')");
    query.mockResolvedValue([]);
    expect(await isRideResponseDeliverable({ query } as any, item)).toBe(false);
  });
  it('request acceptance checks the selected driver, trip and precise selection event on every retry', async () => {
    const query = jest.fn().mockResolvedValue([{}]);
    const item = notification('trip_request_accepted');
    item.data!.tripId = uuid(9); item.data!.selectedAt = new Date().toISOString();
    query.mockResolvedValue([{ selectedAt: new Date(item.data!.selectedAt) }]);
    expect(await isRideResponseDeliverable({ query } as any, item)).toBe(true);
    expect(query.mock.calls[0][1]).toEqual([uuid(5), uuid(2), uuid(2), uuid(9)]);
    expect(query.mock.calls[0][0]).toContain("r.status = 'driver_selected'");
    expect(query.mock.calls[0][0]).toContain('LEFT JOIN trips t ON t.id = CASE');
    expect(query.mock.calls[0][0]).toContain('THEN r."tripId"::uuid ELSE NULL END');
    expect(query.mock.calls[0][0]).toContain('($4::uuid IS NULL OR t.id = $4)');
    expect(query.mock.calls[0][0]).not.toContain('t.id::text');
    expect(query.mock.calls[0][0]).not.toContain('::timestamptz');
    query.mockResolvedValue([{ selectedAt: new Date(0) }]);
    expect(await isRideResponseDeliverable({ query } as any, item)).toBe(false);
    query.mockResolvedValue([]);
    expect(await isRideResponseDeliverable({ query } as any, item)).toBe(false);
  });
  it('index preparation is additive, bounded and never replays notification history', async () => {
    const migration = new RideResponseOutbox1780000084000();
    const query = jest.fn();
    await expect(migration.up({ query, isTransactionActive: false } as any)).rejects.toThrow('transaction');
    expect(query).not.toHaveBeenCalled();
    await migration.up({ query, isTransactionActive: true } as any);
    expect(query.mock.calls).toHaveLength(3);
    expect(query.mock.calls[0][0]).toContain("lock_timeout = '3s'");
    expect(query.mock.calls[2][0]).toContain("'booking_response', 'trip_request_accepted'");
    expect(query.mock.calls.map(c => c[0]).join('\n')).not.toMatch(/\b(UPDATE|DELETE|DROP)\b/);
  });
});
