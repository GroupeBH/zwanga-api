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
  return { title: price ? `Zwanga · ${price}` : notification.title,
    body: price && route ? `${route}\nOuvrez Zwanga pour accepter ou refuser.` : notification.body };
}
