import { getMessaging } from 'firebase-admin/messaging';
import { NotificationService } from './notifications.service';
import { Notification, NotificationStatus } from './entities/notification.entity';
import { TripRequest, TripRequestStatus } from '../trip-requests/entities/trip-request.entity';
import { recoverDriverOffer } from './recover-driver-offer';
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
      sharedTrip: true, existingTripId: uuid(7), ridePricePerSeat: '2500', ridePriceKind: 'budget' });
    expect(Buffer.byteLength(JSON.stringify(payload), 'utf8')).toBeLessThan(4096);
    expect(JSON.parse(payload.body)).toMatchObject({ passengerId: uuid(3), driverId: uuid(2),
      sharedTrip: true, existingTripId: uuid(7), ridePricePerSeat: '2500' });
    expect(payload).not.toHaveProperty('unknownBlob');
  });
});

describe('recovery of interrupted/failed delivery, not answered offers', () => {
  const fixture = () => {
    const request: any = { id: uuid(5), status: TripRequestStatus.PENDING, passengerId: uuid(3),
      selectedDriverId: null, departureDateMax: new Date(Date.now() + 60_000),
      departurePoint: { coordinates: [0, 0] }, numberOfSeats: 1, vehicleType: 'car' };
    const offer = { id: uuid(4), status: 'pending', expiresAt: new Date(Date.now() + 10_000), vehicleId: uuid(7), seats: 4 };
    const flags = { presence: true, other: false };
    const update = jest.fn();
    const findOne = jest.fn(async () => request);
    const query = jest.fn(async (sql: string, _parameters?: unknown[]) => {
      if (sql.startsWith('SELECT *')) return [offer];
      if (sql.includes('SELECT p."driverId"')) return flags.presence ? [{}] : [];
      if (sql.includes('SELECT 1')) return flags.other ? [{}] : [];
      return [];
    });
    const manager: any = { query, getRepository: (entity: unknown) =>
      entity === TripRequest ? { findOne } : { update } };
    return { request, offer, flags, manager, query, update };
  };
  it('renews a still-live offer before delivery without allocating a duplicate', async () => {
    const f = fixture(); const item = notification('driver_dispatch_offer');
    await recoverDriverOffer(f.manager, item);
    expect(f.query.mock.calls.at(-1)![0]).toContain("SET status = 'pending'");
    expect(f.query.mock.calls.at(-1)![1][0]).toBe(uuid(4));
    expect(item.data!.deliveryRenewals).toBe(1);
    expect(Date.parse(item.data!.expiresAt) - Date.now()).toBeGreaterThan(20_000);
    expect(f.update).toHaveBeenCalledWith(item.id, { data: item.data });
    expect(f.query.mock.calls[1][0]).toContain('ST_DWithin');
    expect(f.query.mock.calls[1][1]!.at(-1)).toBe(5000);
    expect(f.query.mock.calls[2][0]).toContain('OR "requestId" = $3');
    expect(f.query.mock.calls[2][1]).toEqual([item.userId, uuid(4), uuid(5)]);
  });
  it.each(['declined', 'cancelled', 'accepted', 'expired'])('never revives an offer already %s', async status => {
    const f = fixture(); f.offer.status = status;
    await recoverDriverOffer(f.manager, notification('driver_dispatch_offer'));
    expect(f.update).not.toHaveBeenCalled();
  });
  it('does not revive a timed-out offer before the expiration cron has updated its status', async () => {
    const f = fixture(); f.offer.expiresAt = new Date(Date.now() - 1);
    await recoverDriverOffer(f.manager, notification('driver_dispatch_offer'));
    expect(f.update).not.toHaveBeenCalled();
    expect(f.query).toHaveBeenCalledTimes(1);
  });
  it.each(['sent', 'old', 'cap', 'own', 'selected', 'expired-request', 'disabled', 'other-offer'])('does not renew for %s', async condition => {
    const f = fixture(); const item = notification('driver_dispatch_offer');
    if (condition === 'sent') item.status = NotificationStatus.SENT;
    if (condition === 'old') item.createdAt = new Date(Date.now() - 301_000);
    if (condition === 'cap') item.data!.deliveryRenewals = 2;
    if (condition === 'own') f.request.passengerId = item.userId;
    if (condition === 'selected') f.request.selectedDriverId = uuid(8);
    if (condition === 'expired-request') f.request.departureDateMax = new Date(0);
    if (condition === 'disabled') f.flags.presence = false;
    if (condition === 'other-offer') f.flags.other = true;
    await recoverDriverOffer(f.manager, item);
    expect(f.update).not.toHaveBeenCalled();
  });
  it('renews a queued nearby transport window only twice and never an already sent alert', async () => {
    const f = fixture(); const item = notification('trip_request_nearby');
    for (let i = 0; i < 3; i++) {
      item.data!.alertExpiresAt = new Date(0).toISOString();
      await recoverDriverOffer(f.manager, item);
    }
    expect(f.update).toHaveBeenCalledTimes(2);
    item.data!.deliveryRenewals = 0; item.status = NotificationStatus.SENT;
    await recoverDriverOffer(f.manager, item);
    expect(f.update).toHaveBeenCalledTimes(2);
    expect(f.query).not.toHaveBeenCalled();
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
