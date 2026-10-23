import type { Message } from 'firebase-admin/messaging';
import type { Notification } from './entities/notification.entity';

/** Native APNs alert: no VoIP, no critical sound, no dependency on headless JS. */
export function iosDriverPush(notification: Notification, token: string, ringUntil: string): Message {
  const type = notification.data?.type;
  const nearby = type === 'trip_request_nearby';
  const response = type === 'booking_response' || type === 'trip_request_accepted';
  const data = Object.fromEntries(Object.entries({ ...notification.data, ringUntil,
    ...(response ? {} : nearby ? { delivery: 'driver-phone-v3' } : { actionProtocol: 'driver-v1', ringVersion: 'v2' }),
  }).filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => [key, String(value)]));
  for (const field of ['invitationText', 'rideDeparture', 'rideArrival']) if (data[field]) data[field] = data[field].slice(0, 120);
  const id = data.offerId ?? data.bookingId ?? data.tripRequestId;
  const expiry = Math.floor(Date.parse(ringUntil) / 1000);
  if (!Number.isFinite(expiry)) throw new Error('IOS_DRIVER_DEADLINE_INVALID');
  const message: Message = { token, data, apns: {
    headers: { 'apns-push-type': 'alert', 'apns-priority': '10', 'apns-expiration': String(expiry),
      ...(id ? { 'apns-collapse-id': `${nearby ? 'nearby' : type === 'new_booking' ? 'booking' : 'offer'}-${id}` } : {}) },
    payload: {
      // Preserve the Expo-compatible shape for the shared native action bridge.
      body: data,
      aps: { alert: { title: notification.title.slice(0, 100), body: notification.body.slice(0, 300) },
        sound: 'driver_ring.wav', ...(response ? {} : { category: nearby ? 'driver-nearby-v1' : 'driver-offer-v2' }),
        'interruption-level': 'time-sensitive', threadId: 'zwanga-ride-requests' },
    },
  } };
  if (Buffer.byteLength(JSON.stringify({ data: message.data, apns: message.apns }), 'utf8') > 3800)
    throw new Error('IOS_DRIVER_PAYLOAD_TOO_LARGE');
  return message;
}
