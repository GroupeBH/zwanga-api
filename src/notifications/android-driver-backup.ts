import type { Notification } from './entities/notification.entity';

/** Expo SDK54 presents title/message in an FCM data message natively while
 * still delivering the JS task. The quiet backup survives a stalled JS runtime.
 * v4 is advertised only after its channel exists; older clients stay unchanged. */
export function androidDriverBackup(_notification: Notification, data: Record<string, unknown>) {
  const kind = data.type === 'new_booking' ? 'booking' : data.type === 'driver_dispatch_offer' ? 'dispatch' : 'nearby';
  const id = kind === 'booking' ? data.bookingId : kind === 'dispatch' ? data.offerId : data.tripRequestId;
  const fallbackTag = `ride-backup-${kind}-${id}`;
  const fields = ['type', 'actionProtocol', 'notificationId', 'bookingId', 'tripId', 'tripRequestId', 'offerId',
    'driverId', 'passengerId', 'ringAlert', 'ringVersion', 'ringUntil', 'expiresAt', 'alertExpiresAt',
    'delivery', 'sharedTrip', 'existingTripId', 'rideSpeechVersion', 'rideDeparture', 'rideArrival',
    'rideSeats', 'rideDepartureAt', 'ridePricePerSeat', 'ridePriceKind', 'invitationText'];
  const content: Record<string, unknown> = { ...Object.fromEntries(fields
    .filter(field => data[field] !== undefined && data[field] !== null)
    .map(field => [field, data[field]])), alertDelivery: 'native-backup-v4', fallbackTag };
  // Direct payload and Expo body both carry the fields. Long optional prose
  // must not cause FCM to reject the entire alert (>4096 bytes).
  for (const field of ['invitationText', 'rideDeparture', 'rideArrival']) {
    if (typeof content[field] === 'string') content[field] = (content[field] as string).slice(0, 120);
  }
  if (Buffer.byteLength(JSON.stringify(content), 'utf8') > 1550) {
    delete content.invitationText; delete content.rideDeparture; delete content.rideArrival;
  }
  const body = JSON.stringify(content);
  // No secrets or imagery. Keep identity metadata intact within FCM's 4KB limit.
  const payload = { ...content, title: kind === 'booking' ? 'Réservation à traiter' : 'Demande à consulter',
    message: 'Ouvrez Zwanga pour voir les détails et répondre.',
    body, channelId: 'driver-alert-backup-v1', tag: fallbackTag, autoDismiss: 'false', sound: 'none' };
  if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > 3800) {
    // Never truncate recipient IDs or action/consent fields to make an invalid
    // notification fit. Fail this delivery for diagnosis, not FCM indefinitely.
    throw new Error('DRIVER_ALERT_PAYLOAD_TOO_LARGE');
  }
  return payload;
}

export function androidDriverBackupTtl(notification: Notification, now = Date.now()): number {
  // Scheduled sequential invitations also expire. A five-minute transport
  // lifetime could deliver their safety card after the next driver was invited.
  // This bounds delivery only; it cannot stop sound already owned by Android.
  const expiries = [notification.data?.expiresAt, notification.data?.alertExpiresAt]
    .map(value => Date.parse(String(value ?? ''))).filter(Number.isFinite);
  return Math.max(1, Math.min(now + 5 * 60_000, ...expiries) - now);
}
