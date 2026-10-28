import type { Notification } from './entities/notification.entity';

/** Never invent the fare; a request carries a per-seat budget, a booking a fare. */
export function rideCardContent(notification: Notification) {
  const d = notification.data;
  if (!d || !['new_booking', 'trip_request_nearby', 'driver_dispatch_offer'].includes(d.type))
    return { title: notification.title, body: notification.body };
  const raw = d.ridePricePerSeat;
  const amount = ['fare', 'budget'].includes(d.ridePriceKind) &&
    typeof raw === 'string' && /^\d{1,10}(\.\d{1,2})?$/.test(raw) ? Number(raw) : undefined;
  const price = amount === undefined ? '' : amount === 0 ? 'Gratuit' :
    `${d.ridePriceKind === 'budget' ? 'Budget : ' : ''}${amount.toLocaleString('fr-FR')} FC / place`;
  const label = (v: unknown) => typeof v === 'string' ? v.slice(0, 1600).replace(/<[^>]*>/g, ' ').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 100) : '';
  const from = label(d.rideDeparture), to = label(d.rideArrival);
  const route = to ? `${from ? from + ' → ' : 'Vers '}${to}` : from;
  const seats = typeof d.rideSeats === 'string' && /^[1-9]\d?$/.test(d.rideSeats)
    ? `${d.rideSeats} place${d.rideSeats === '1' ? '' : 's'}` : '';
  const departureAt = typeof d.rideDepartureAt === 'string' ? Date.parse(d.rideDepartureAt) : NaN;
  const schedule = Number.isFinite(departureAt) ? `Départ : ${new Date(departureAt).toLocaleString('fr-FR', {
    timeZone: 'Africa/Kinshasa', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  })}` : '';
  const details = [seats, schedule].filter(Boolean).join(' · ');
  return { title: price ? `Zwanga · ${price}` : notification.title,
    body: price ? [price, route, details, 'Ouvrez Zwanga pour répondre.'].filter(Boolean).join('\n')
      : [notification.body, details].filter(Boolean).join('\n') };
}
