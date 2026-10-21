import type { EntityManager } from 'typeorm';
import { Notification } from './entities/notification.entity';
import { TripRequest, TripRequestStatus } from '../trip-requests/entities/trip-request.entity';
import { USABLE_DRIVER_LOCATION_SQL } from '../trip-requests/dispatch/driver-location-policy';
import { ELIGIBLE_NEARBY_DRIVER_SQL, NEARBY_DRIVER_RADIUS_METERS } from '../trip-requests/dispatch/nearby-driver-policy';
import { boundedInteger } from '../trip-requests/dispatch/dispatch-policy';

/** Recover a queued/failed delivery, never a SENT notification or an ended offer.
 * Reuses a still-live offer and allows at most two renewed delivery windows.
 * All business checks remain mandatory again when the driver responds. */
export async function recoverDriverOffer(manager: EntityManager, notification: Notification, responseSeconds = 30): Promise<void> {
  const data = notification.data;
  if (data?.type === 'trip_request_nearby') {
    if (notification.status === 'sent' || Date.parse(String(data.alertExpiresAt)) > Date.now() ||
        !Number.isFinite(new Date(notification.createdAt).getTime()) ||
        Date.now() - new Date(notification.createdAt).getTime() > 5 * 60_000 ||
        Number(data.deliveryRenewals ?? 0) >= 2) return;
    // This only renews transport freshness. The dispatcher still checks the
    // current request, recipient and any shared-ride consent before sending.
    notification.data = { ...data, alertExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      deliveryRenewals: Number(data.deliveryRenewals ?? 0) + 1 };
    await manager.getRepository(Notification).update(notification.id, { data: notification.data });
    return;
  }
  if (data?.type !== 'driver_dispatch_offer' || notification.status === 'sent' ||
      Date.parse(String(data.expiresAt)) - Date.now() > 15_000 ||
      Date.now() - new Date(notification.createdAt).getTime() > 5 * 60_000 ||
      !Number.isFinite(new Date(notification.createdAt).getTime()) ||
      Number(data.deliveryRenewals ?? 0) >= 2 || !data.tripRequestId) return;
  // Same lock order as respond(): request, offer, presence.
  const request = await manager.getRepository(TripRequest).findOne({
    where: { id: data.tripRequestId }, lock: { mode: 'pessimistic_write' },
  });
  if (!request || request.status !== TripRequestStatus.PENDING || request.selectedDriverId || request.tripId ||
      !request.departurePoint || request.passengerId === notification.userId || request.departureDateMax.getTime() <= Date.now()) return;
  const [offer] = await manager.query(`SELECT * FROM trip_request_dispatch_offers
    WHERE id = $1 AND "driverId" = $2 AND "requestId" = $3 FOR UPDATE`,
    [data.offerId, notification.userId, request.id]);
  // A timed-out invitation has yielded its turn, even if the expiration cron
  // has not updated its status yet. Never resurrect it behind its successor.
  if (!offer || offer.status !== 'pending' || !(new Date(offer.expiresAt).getTime() > Date.now())) return;
  const [presence] = await manager.query(`SELECT p."driverId" FROM driver_dispatch_presence p
    JOIN vehicles v ON v.id = $2 AND v."ownerId" = p."driverId" AND v."isActive" = true
    WHERE p."driverId" = $1 AND ${USABLE_DRIVER_LOCATION_SQL}
      AND ${ELIGIBLE_NEARBY_DRIVER_SQL} AND v.type = $3 AND $4::integer >= $5::integer
      AND ST_DWithin(p.position, ST_SetSRID(ST_MakePoint($6,$7),4326)::geography, $8)
    FOR UPDATE OF p`, [notification.userId, offer.vehicleId, request.vehicleType, offer.seats,
      request.numberOfSeats, request.departurePoint.coordinates[0], request.departurePoint.coordinates[1],
      NEARBY_DRIVER_RADIUS_METERS]);
  if (!presence) return;
  const other = await manager.query(`SELECT 1 FROM trip_request_dispatch_offers
    WHERE ("driverId" = $1 OR "requestId" = $3) AND id <> $2 AND status = 'pending' LIMIT 1`,
    [notification.userId, offer.id, request.id]);
  if (other.length) return;
  const expiresAt = new Date(Math.min(Date.now() + boundedInteger(String(responseSeconds), 30, 10, 120) * 1000, request.departureDateMax.getTime()));
  await manager.query(`UPDATE trip_request_dispatch_offers SET status = 'pending', "expiresAt" = $2 WHERE id = $1`,
    [offer.id, expiresAt]);
  notification.data = { ...data, expiresAt: expiresAt.toISOString(), deliveryRenewals: Number(data.deliveryRenewals ?? 0) + 1 };
  await manager.getRepository(Notification).update(notification.id, { data: notification.data });
}
