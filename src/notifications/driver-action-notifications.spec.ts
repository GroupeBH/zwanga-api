import { getMessaging } from 'firebase-admin/messaging';
import { NotificationService } from './notifications.service';
import { BookingsService } from '../bookings/bookings.service';
import { Booking } from '../bookings/entities/booking.entity';
import { DriverDispatchService } from '../trip-requests/dispatch/dispatch.service';
import { createHash } from 'node:crypto';

jest.mock('firebase-admin/messaging', () => ({ getMessaging: jest.fn() }));

describe('driver notification transport', () => {
  const fixture = (capable: boolean) => {
    const send = jest.fn().mockResolvedValue('message-id');
    (getMessaging as jest.Mock).mockReturnValue({ send });
    const query = jest.fn().mockResolvedValue(capable ? [{}] : []);
    const service = Object.assign(Object.create(NotificationService.prototype), {
      firebaseApp: {}, configService: { get: () => 'true' }, notificationRepository: { manager: { query } },
    });
    return { service, send, query };
  };
  it('uses headless high-priority data only for a capable driver installation', async () => {
    const { service, send } = fixture(true);
    await service.sendFirebaseNotification({ userId: 'driver', title: 'Nouvelle réservation', body: 'Test',
      data: { type: 'new_booking', bookingId: 'booking', driverId: 'driver' } }, 'fixture-token');
    const payload = send.mock.calls[0][0];
    expect(payload.notification).toBeUndefined();
    expect(payload.data.title).toBeUndefined();
    expect(payload.data.body).toBeUndefined();
    expect(payload.data.message).toBeUndefined();
    expect(payload.data.actionProtocol).toBe('driver-v1');
    expect(payload.android.priority).toBe('high');
  });
  it('keeps notification+data for an older installation', async () => {
    const { service, send } = fixture(false);
    await service.sendFirebaseNotification({ userId: 'driver', title: 'Titre', body: 'Texte', data: { type: 'new_booking' } }, 'fixture-token');
    expect(send.mock.calls[0][0].notification).toEqual({ title: 'Titre', body: 'Texte' });
  });
  it('does not change message notifications or query driver capabilities for them', async () => {
    const { service, send, query } = fixture(true);
    await service.sendFirebaseNotification({ userId: 'driver', title: 'Message', body: 'Texte', data: { type: 'message' } }, 'fixture-token');
    expect(query).not.toHaveBeenCalled();
    expect(send.mock.calls[0][0].data.actionProtocol).toBeUndefined();
  });
  it('GPS reminders remain ordinary notifications and are suppressed after recovery or dispatch shutdown', async () => {
    const { service, send, query } = fixture(true);
    const notification = { userId: 'driver', title: 'Position', body: 'Ouvrez Zwanga',
      data: { type: 'driver_location_stale', driverId: 'driver', locationUpdatedAt: new Date(Date.now() - 7 * 3600000).toISOString() } };
    await service.sendFirebaseNotification(notification, 'synthetic-token');
    expect(query).not.toHaveBeenCalled();
    expect(send.mock.calls[0][0].data.actionProtocol).toBeUndefined();
    expect(send.mock.calls[0][0].data.ringUntil).toBeUndefined();
    expect(await service.isCriticalNotificationStillDeliverable(notification)).toBe(true);
    query.mockResolvedValue([]);
    expect(await service.isCriticalNotificationStillDeliverable(notification)).toBe(false);
    service.configService.get = () => 'false'; query.mockClear();
    expect(await service.isCriticalNotificationStillDeliverable(notification)).toBe(false);
    expect(query).not.toHaveBeenCalled();
  });
  it('requests the iOS sound without capability registration but gates categories and time-sensitive', async () => {
    const original = global.fetch;
    const send = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ data: { status: 'ok', id: 'test-ticket' } }) });
    global.fetch = send;
    try {
      for (const version of [0, 1, 2]) {
        const { service, query } = fixture(true); query.mockResolvedValue(version ? [{ version }] : []);
        await service.sendExpoPushNotification({ userId: 'driver', title: 'Réservation', body: 'Test', data: { type: 'new_booking' } }, 'ExponentPushToken[test]');
        const payload = JSON.parse(send.mock.calls.at(-1)![1].body);
        expect(payload.categoryId).toBe(version ? `driver-offer-v${version}` : undefined);
        expect(payload.sound).toBe('driver_ring.wav');
        expect(payload.data.actionProtocol).toBe(version ? 'driver-v1' : undefined);
        expect(payload.ttl).toBeLessThanOrEqual(30);
        expect(payload.interruptionLevel).toBe(version === 2 ? 'time-sensitive' : undefined);
        expect(payload.channelId).toBe(version === 2 ? 'booking-ring-v2' : undefined);
        if (version === 2) {
          expect(Date.parse(payload.data.ringUntil)).toBeGreaterThan(Date.now());
          expect(payload.ttl).toBeLessThanOrEqual(30);
        } else expect(payload.data.ringUntil).toBeUndefined();
      }
    } finally { global.fetch = original; }
  });
  it('only targeted enabled iOS invitations ring when interactive registration is absent', async () => {
    const original = global.fetch;
    const send = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ data: { status: 'ok', id: 'ticket' } }) });
    global.fetch = send;
    try {
      for (const enabled of [true, false]) {
        for (const type of ['driver_dispatch_offer', 'trip_request', 'message']) {
          const { service } = fixture(false); service.configService.get = () => String(enabled);
          await service.sendExpoPushNotification({ userId: 'driver', body: 'Test', data: {
            type, expiresAt: new Date(Date.now() + 5000).toISOString(),
          } }, 'ExponentPushToken[test]');
          const payload = JSON.parse(send.mock.calls.at(-1)![1].body);
          expect(payload.sound).toBe(enabled && type === 'driver_dispatch_offer' ? 'driver_ring.wav' : 'default');
          expect(payload.data.actionProtocol).toBeUndefined();
          expect(payload.categoryId).toBeUndefined();
          expect(payload.interruptionLevel).toBeUndefined();
          if (enabled && type === 'driver_dispatch_offer') expect(payload.ttl).toBeLessThanOrEqual(5);
        }
      }
    } finally { global.fetch = original; }
  });
  it('keeps nearby invitations headless with a long-ring capable recipient', async () => {
    const { service, send, query } = fixture(true); query.mockResolvedValue([{ version: 2 }]);
    await service.sendFirebaseNotification({ userId: 'driver', body: 'Nearby', data: {
      type: 'driver_dispatch_offer', offerId: 'offer', driverId: 'driver',
      expiresAt: new Date(Date.now() + 30000).toISOString(),
    } }, 'fixture-token');
    const payload = send.mock.calls[0][0];
    expect(payload.notification).toBeUndefined();
    expect(payload.data).toMatchObject({ actionProtocol: 'driver-v1', ringVersion: 'v2' });
    expect(payload.android).toMatchObject({ priority: 'high' });
    expect(payload.android.ttl).toBeLessThanOrEqual(30000);
    expect(Date.parse(payload.data.ringUntil)).toBeLessThanOrEqual(Date.now() + 30000);
  });
  it('bounds ringing transport to 30s for a booking without changing its business expiry', async () => {
    const { service, send, query } = fixture(true); query.mockResolvedValue([{ version: 2 }]);
    const data = { type: 'new_booking', bookingId: 'booking', driverId: 'driver' };
    await service.sendFirebaseNotification({ userId: 'driver', body: 'Booking', data }, 'fixture-token');
    const payload = send.mock.calls[0][0];
    expect(payload.android.ttl).toBeGreaterThan(0);
    expect(payload.android.ttl).toBeLessThanOrEqual(30000);
    expect(payload.data.expiresAt).toBeUndefined();
    expect(data).not.toHaveProperty('ringUntil');
  });
  it('never extends a shorter dispatch deadline to provide a full 30s sound', async () => {
    const { service, send, query } = fixture(true); query.mockResolvedValue([{ version: 2 }]);
    const expiresAt = new Date(Date.now() + 5000).toISOString();
    await service.sendFirebaseNotification({ userId: 'driver', body: 'Nearby', data: {
      type: 'driver_dispatch_offer', expiresAt,
    } }, 'fixture-token');
    const payload = send.mock.calls[0][0];
    expect(payload.data.ringUntil).toBe(expiresAt);
    expect(payload.android.ttl).toBeLessThanOrEqual(5000);
  });
  it('rings for the passenger after acceptance without assigning driver actions', async () => {
    for (const version of [0, 1, 2]) {
      const { service, send, query } = fixture(true);
      query.mockResolvedValue(version ? [{ version }] : []);
      await service.sendFirebaseNotification({ userId: 'passenger', title: 'Demande acceptée', body: 'Texte',
        data: { type: 'trip_request_accepted', tripRequestId: 'request', driverId: 'driver' } }, 'passenger-token');
      const payload = send.mock.calls[0][0];
      expect(payload.notification.title).toBe('Demande acceptée');
      expect(payload.data.actionProtocol).toBeUndefined();
      expect(query.mock.calls[0][1][0]).toBe('passenger');
      if (version === 2) {
        expect(payload.android).toMatchObject({ priority: 'high', ttl: 60000,
          notification: { channelId: 'booking-ring-v2', sound: 'driver_ring' } });
        expect(payload.data.ringAlert).toBe('request-accepted-v1');
      } else { expect(payload.android).toBeUndefined(); expect(payload.data.ringAlert).toBeUndefined(); }
    }
  });
  it('uses the bundled iOS sound for accepted requests, including dispatch without a trip yet', async () => {
    const original = global.fetch;
    const send = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ data: { status: 'ok', id: 'ticket' } }) });
    global.fetch = send;
    try {
      for (const version of [0, 1, 2]) {
        const { service, query } = fixture(true); query.mockResolvedValue(version ? [{ version }] : []);
        service.configService.get = () => 'false';
        await service.sendExpoPushNotification({ userId: 'passenger', title: 'Acceptée', body: 'Texte',
          data: { type: 'trip_request_accepted', tripRequestId: 'request' } }, 'ExponentPushToken[test]');
        const payload = JSON.parse(send.mock.calls.at(-1)![1].body);
        expect(payload.sound).toBe(version === 2 ? 'driver_ring.wav' : 'default');
        expect(payload.interruptionLevel).toBe(version === 2 ? 'time-sensitive' : undefined);
        expect(payload.categoryId).toBeUndefined();
        expect(payload.data.actionProtocol).toBeUndefined();
      }
    } finally { global.fetch = original; }
  });
  it('keeps general broadcasts standard and does not enable dispatch through sound capability', async () => {
    const { service, send, query } = fixture(true); query.mockResolvedValue([{ version: 2 }]);
    service.configService.get = () => 'false';
    for (const type of ['trip_request', 'driver_dispatch_offer']) {
      await service.sendFirebaseNotification({ userId: 'driver', title: 'Titre', body: 'Texte', data: { type } }, 'token');
      expect(send.mock.calls.at(-1)![0].data.actionProtocol).toBeUndefined();
      expect(send.mock.calls.at(-1)![0].android).toBeUndefined();
    }
    expect(query).not.toHaveBeenCalled();
    await service.sendFirebaseNotification({ userId: 'driver', body: 'Texte', data: { type: 'new_booking' } }, 'token');
    expect(send.mock.calls.at(-1)![0].data.actionProtocol).toBe('driver-v1');
  });
  it('registers a passenger sound capability even if nearby allocation is disabled', async () => {
    const query = jest.fn();
    const service = Object.assign(Object.create(DriverDispatchService.prototype), {
      config: { get: () => 'false' }, db: { query,
        getRepository: () => ({ findOne: async () => ({ id: 'passenger', fcmToken: 'synthetic-token' }) }) },
    });
    await expect(service.registerNotifications('passenger', 2)).resolves.toEqual({ registered: true });
    expect(query).toHaveBeenCalledTimes(1);
  });
  it('binds v3 capability to the current push token without changing the table schema', async () => {
    const query = jest.fn();
    const service = Object.assign(Object.create(DriverDispatchService.prototype), {
      db: { query, getRepository: () => ({ findOne: async () => ({ id: 'driver', fcmToken: 'synthetic-token' }) }) },
    });
    await expect(service.registerNotifications('driver', 3)).resolves.toEqual({ registered: true });
    expect(query.mock.calls[0][1]).toEqual(['driver', createHash('sha256').update('synthetic-token:driver-v3').digest('hex')]);
    expect(query.mock.calls[0][0]).toContain('ON CONFLICT ("userId")');
  });

  const scheduled = () => ({ userId: 'driver', title: 'Commande programmée à proximité', body: 'Consultez la commande',
    data: { type: 'trip_request_nearby', ringAlert: 'nearby-request-v1', tripRequestId: 'request', driverId: 'driver',
      alertExpiresAt: new Date(Date.now() + 60_000).toISOString() } });
  it('v3 scheduled orders use data-only delivery so the native timeout bounds the phone ringtone', async () => {
    const { service, send, query } = fixture(true); query.mockResolvedValue([{ version: 3 }]);
    await service.sendFirebaseNotification(scheduled(), 'fixture-token');
    const payload = send.mock.calls[0][0];
    expect(payload.notification).toBeUndefined();
    expect(payload.android.notification).toBeUndefined();
    expect(payload.data).toMatchObject({ delivery: 'driver-phone-v3', ringAlert: 'nearby-request-v1' });
    expect(payload.data.actionProtocol).toBeUndefined();
    expect(payload.android.ttl).toBeGreaterThan(0);
    expect(payload.android.ttl).toBeLessThanOrEqual(30000);
    expect(Date.parse(payload.data.ringUntil)).toBeLessThanOrEqual(Date.now() + 30000);
  });
  it.each(['new_booking', 'driver_dispatch_offer'])('v3 %s retains the existing actions and 30s deadline', async type => {
    const { service, send, query } = fixture(true); query.mockResolvedValue([{ version: 3 }]);
    await service.sendFirebaseNotification({ userId: 'driver', body: 'Test', data: { type, driverId: 'driver' } }, 'token');
    const payload = send.mock.calls[0][0];
    expect(payload.notification).toBeUndefined();
    expect(payload.data).toMatchObject({ actionProtocol: 'driver-v1', ringVersion: 'v2' });
    expect(payload.android.ttl).toBeLessThanOrEqual(30000);
  });
  it('v3 does not turn the passenger acceptance into a driver phone ringtone', async () => {
    const { service, send, query } = fixture(true); query.mockResolvedValue([{ version: 3 }]);
    await service.sendFirebaseNotification({ userId: 'passenger', body: 'Test', data: { type: 'trip_request_accepted' } }, 'token');
    expect(send.mock.calls[0][0].android.notification.channelId).toBe('booking-ring-v2');
    expect(send.mock.calls[0][0].data.delivery).toBeUndefined();
  });
  it('uses the long Android channel for scheduled requests without treating them as exclusive dispatch', async () => {
    const { service, send, query } = fixture(true); query.mockResolvedValue([{ version: 2 }]);
    await service.sendFirebaseNotification(scheduled(), 'fixture-token');
    const payload = send.mock.calls[0][0];
    expect(payload.notification.title).toBe('Commande programmée à proximité');
    expect(payload.data).toMatchObject({ type: 'trip_request_nearby', ringAlert: 'nearby-request-v1' });
    expect(payload.data.actionProtocol).toBeUndefined();
    expect(payload.android).toMatchObject({ priority: 'high', notification: {
      channelId: 'booking-ring-v2', sound: 'driver_ring', visibility: 'private', tag: 'request-nearby-request' } });
    expect(payload.android.ttl).toBeGreaterThan(0); expect(payload.android.ttl).toBeLessThanOrEqual(30_000);
  });
  it('uses the bundled iOS sound and a bounded lifetime for scheduled requests', async () => {
    const original = global.fetch;
    const send = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ data: { status: 'ok', id: 'ticket' } }) });
    global.fetch = send;
    try {
      const { service, query } = fixture(true); query.mockResolvedValue([{ version: 2 }]);
      const notification = scheduled(); notification.data.alertExpiresAt = new Date(Date.now() + 5000).toISOString();
      await service.sendExpoPushNotification(notification, 'ExponentPushToken[test]');
      const payload = JSON.parse(send.mock.calls[0][1].body);
      expect(payload).toMatchObject({ sound: 'driver_ring.wav', priority: 'high', interruptionLevel: 'time-sensitive', channelId: 'booking-ring-v2' });
      expect(payload.ttl).toBeGreaterThan(0); expect(payload.ttl).toBeLessThanOrEqual(5);
      expect(payload.categoryId).toBeUndefined(); expect(payload.data.actionProtocol).toBeUndefined();
    } finally { global.fetch = original; }
  });
  it.each(['old-client', 'disabled', 'foreign-recipient', 'unmarked'])('does not enable scheduled ringing for %s', async reason => {
    const { service, send, query } = fixture(true); query.mockResolvedValue([{ version: reason === 'old-client' ? 1 : 2 }]);
    if (reason === 'disabled') service.configService.get = () => 'false';
    const notification = scheduled();
    if (reason === 'foreign-recipient') notification.data.driverId = 'other-driver';
    if (reason === 'unmarked') notification.data.ringAlert = '';
    await service.sendFirebaseNotification(notification, 'fixture-token');
    expect(send.mock.calls[0][0].android).toBeUndefined();
    expect(send.mock.calls[0][0].data.actionProtocol).toBeUndefined();
  });
  it('checks the saved request before outbox delivery and suppresses expired or already handled alerts', async () => {
    const { service, query } = fixture(true); const notification = scheduled();
    await expect(service.isCriticalNotificationStillDeliverable(notification)).resolves.toBe(true);
    expect(query.mock.calls[0][0]).toContain('r."selectedDriverId" IS NULL');
    expect(query.mock.calls[0][0]).toContain('r."tripId" IS NULL');
    expect(query.mock.calls[0][0]).toContain('r."departureDateMax" > now()');
    expect(query.mock.calls[0][1]).toEqual(['request']);
    query.mockResolvedValue([]);
    await expect(service.isCriticalNotificationStillDeliverable(notification)).resolves.toBe(false);
    query.mockClear(); notification.data.alertExpiresAt = new Date(0).toISOString();
    await expect(service.isCriticalNotificationStillDeliverable(notification)).resolves.toBe(false);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('booking invitation late actions', () => {
  const fixture = (status: string) => {
    const booking = { id: 'booking', tripId: 'trip', passengerId: 'passenger', status };
    const trip = { id: 'trip', driverId: 'driver' };
    const manager = { getRepository: (entity: unknown) => ({ findOne: async () => entity === Booking ? booking : trip }) };
    const service = Object.assign(Object.create(BookingsService.prototype), {
      bookingRepository: { manager: { transaction: (work: (value: unknown) => Promise<unknown>) => work(manager) } },
      invalidateBookingCaches: jest.fn(), refundPointsPaymentIfNeeded: jest.fn(), logger: { log() {}, warn() {} },
    });
    return service;
  };
  it('does not reject a booking another device already accepted', async () => {
    await expect(fixture('accepted').respondToInvitation('booking', 'driver', false)).rejects.toThrow('déjà été traitée');
  });
  it('an identical accepted reply is idempotent', async () => {
    await expect(fixture('accepted').respondToInvitation('booking', 'driver', true)).resolves.toMatchObject({ status: 'accepted' });
  });
  it('another driver cannot reuse an already accepted response', async () => {
    await expect(fixture('accepted').respondToInvitation('booking', 'intruder', true)).rejects.toThrow('Seul le conducteur');
  });
});
