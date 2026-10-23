import { iosDriverPush } from './ios-driver-push';
import type { Notification } from './entities/notification.entity';

describe('native Firebase/APNs driver contract', () => {
  it.each(['new_booking', 'driver_dispatch_offer', 'trip_request_nearby'])('%s uses alert APNs, not a VoIP or critical payload', type => {
    const item = { title: 'Zwanga', body: 'Répondez à la demande', data: { type, bookingId: 'b',
      offerId: 'o', tripRequestId: 'r', driverId: 'driver', rideArrival: 'Gare', ridePricePerSeat: '2000' } } as Notification;
    const until = '2026-10-22T12:00:30.000Z';
    const message: any = iosDriverPush(item, 'synthetic-token', until);
    expect(message.notification).toBeUndefined(); expect(message.android).toBeUndefined();
    expect(message.apns.headers['apns-push-type']).toBe('alert');
    expect(message.apns.headers['apns-expiration']).toBe(String(Date.parse(until) / 1000));
    expect(message.apns.payload.aps).toMatchObject({ sound: 'driver_ring.wav',
      'interruption-level': 'time-sensitive', category: type === 'trip_request_nearby' ? 'driver-nearby-v1' : 'driver-offer-v2' });
    expect(message.apns.payload.body).toMatchObject({ driverId: 'driver', ringUntil: until, rideArrival: 'Gare' });
    expect(Buffer.byteLength(JSON.stringify(message))).toBeLessThan(4096);
  });
  it('rejects invalid deadlines instead of producing an unlimited alert', () => {
    expect(() => iosDriverPush({ title: '', body: '', data: {} } as Notification, 'synthetic-token', 'bad')).toThrow('DEADLINE');
  });
  it('passenger responses have no driver action buttons or invitation protocol', () => {
    const message: any = iosDriverPush({ title: 'Réservation acceptée', body: 'Consultez le trajet',
      data: { type: 'booking_response', bookingId: 'b', passengerId: 'p', ringAlert: 'booking-response-v1' } } as Notification,
    'synthetic-token', '2026-10-22T12:00:30.000Z');
    expect(message.apns.payload.aps.category).toBeUndefined();
    expect(message.data.actionProtocol).toBeUndefined();
    expect(message.data.passengerId).toBe('p');
  });
});
