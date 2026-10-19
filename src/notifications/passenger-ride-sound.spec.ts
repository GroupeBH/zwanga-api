import { getMessaging } from 'firebase-admin/messaging';
import { NotificationService } from './notifications.service';

jest.mock('firebase-admin/messaging', () => ({ getMessaging: jest.fn() }));

describe('passenger reservation response sound', () => {
  const fixture = (version = 2) => {
    const send = jest.fn().mockResolvedValue('message');
    (getMessaging as jest.Mock).mockReturnValue({ send });
    const query = jest.fn().mockResolvedValue(version ? [{ version }] : []);
    const service = Object.assign(Object.create(NotificationService.prototype), {
      firebaseApp: {}, configService: { get: () => 'true' }, notificationRepository: { manager: { query } },
    });
    return { service, send, query };
  };
  const notification = (status: string) => ({ userId: 'synthetic-passenger', title: 'Réponse', body: 'Texte',
    data: { type: 'booking_response', bookingId: 'synthetic-booking', tripId: 'synthetic-trip', status, role: 'passenger' } });

  it.each(['accepted', 'rejected'])('Android %s response gets bundled sound and passenger acknowledgement metadata', async status => {
    const { service, send, query } = fixture(3);
    await service.sendFirebaseNotification(notification(status), 'synthetic-token');
    const push = send.mock.calls[0][0];
    expect(push.notification).toEqual({ title: 'Réponse', body: 'Texte' });
    expect(push.android.notification).toMatchObject({ channelId: 'booking-ring-v2', sound: 'driver_ring', tag: 'ride-response-synthetic-booking' });
    expect(push.data).toMatchObject({ passengerId: 'synthetic-passenger', ringAlert: 'booking-response-v1', status, role: 'passenger' });
    expect(push.data.actionProtocol).toBeUndefined();
    expect(Date.parse(push.data.ringUntil)).toBeGreaterThan(Date.now());
    expect(query.mock.calls[0][1][0]).toBe('synthetic-passenger');
  });

  it.each(['accepted', 'rejected'])('iOS %s response uses the same bundled file, without driver actions', async status => {
    const original = global.fetch;
    const send = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ data: { status: 'ok', id: 'ticket' } }) });
    global.fetch = send;
    try {
      await fixture().service.sendExpoPushNotification(notification(status), 'ExponentPushToken[synthetic]');
      const push = JSON.parse(send.mock.calls[0][1].body);
      expect(push.sound).toBe('driver_ring.wav');
      expect(push.data.ringAlert).toBe('booking-response-v1');
      expect(push.data.passengerId).toBe('synthetic-passenger');
      expect(push.categoryId).toBeUndefined(); expect(push.data.actionProtocol).toBeUndefined();
    } finally { global.fetch = original; }
  });

  it('unregistered passengers still receive an ordinary visible response', async () => {
    const { service, send } = fixture(0);
    await service.sendFirebaseNotification(notification('rejected'), 'synthetic-token');
    expect(send.mock.calls[0][0].notification).toBeDefined();
    expect(send.mock.calls[0][0].data.ringAlert).toBeUndefined();
  });

  it.each(['completed', 'cancelled'])('other booking state %s does not become a ringing response', async status => {
    const { service, send, query } = fixture();
    await service.sendFirebaseNotification(notification(status), 'synthetic-token');
    expect(send.mock.calls[0][0].data.ringAlert).toBeUndefined();
    expect(query).not.toHaveBeenCalled();
  });
});
