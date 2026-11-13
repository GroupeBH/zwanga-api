import type { EntityManager } from 'typeorm';
import { availableAccountSql } from '../users/account-availability';
import type { Notification } from './entities/notification.entity';

/** A delayed response describes the current decision, never just an old event.
 * Checks run again on every retry, including events from older mobile clients. */
export async function isRideResponseDeliverable(manager: EntityManager, notification: Notification): Promise<boolean> {
  const data = notification.data;
  if (!notification.userId || !data) return false;
  if (data.type === 'offer_accepted') {
    // Resolve identity from the saved offer/request, never from a push role.
    const rows = await manager.query(`SELECT 1 FROM driver_offers o JOIN trip_requests r ON r.id=o."tripRequestId"
      LEFT JOIN trips t ON t.id = CASE
        WHEN r."tripId" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        THEN r."tripId"::uuid ELSE NULL END
      WHERE o.id=$1 AND r.id=$2 AND o."driverId"=$3 AND o.status='accepted'
        AND r.status='driver_selected' AND r."selectedDriverId"=o."driverId"
        AND r."passengerId"<>o."driverId"
        AND ${availableAccountSql('r."passengerId"')} AND ${availableAccountSql('o."driverId"')}
        AND (r."tripId" IS NULL OR t.status IN ('upcoming','ongoing'))`,
      [data.offerId, data.tripRequestId, notification.userId]);
    return rows.length > 0;
  }
  if (data.type === 'driver_offer') {
    const rows = await manager.query(`SELECT 1 FROM driver_offers o JOIN trip_requests r ON r.id=o."tripRequestId"
      WHERE o.id=$1 AND r.id=$2 AND o.status='pending'
        AND ((o."negotiationStage"='passenger_counter' AND o."driverId"=$3)
          OR (o."negotiationStage" IS DISTINCT FROM 'passenger_counter' AND r."passengerId"=$3))
        AND ${availableAccountSql('r."passengerId"')} AND ${availableAccountSql('o."driverId"')}
        AND r.status IN ('pending','offers_received') AND r."selectedDriverId" IS NULL AND r."tripId" IS NULL
        AND r."departureDateMax">now() AND (r."targetDriverId" IS NULL OR r."targetDriverId"=o."driverId")
        AND (r."sequentialDispatch"=false OR EXISTS (SELECT 1 FROM trip_request_dispatch_offers d
          WHERE d."requestId"=r.id AND d."driverId"=o."driverId" AND d.status='pending' AND d.phase='passenger' AND d."expiresAt">now()))`,
      [data.offerId, data.tripRequestId, notification.userId]);
    return rows.length > 0;
  }
  if (data.type === 'booking_response') {
    if (!['accepted', 'rejected'].includes(data.status)) return false;
    const rows = await manager.query(`SELECT 1 FROM bookings b JOIN trips t ON t.id = b."tripId"
      WHERE b.id = $1 AND b."passengerId" = $2 AND b.status = $3
        AND ${availableAccountSql('b."passengerId"')} AND ${availableAccountSql('t."driverId"')}
        AND t.status IN ('upcoming', 'ongoing')`, [data.bookingId, notification.userId, data.status]);
    return rows.length > 0;
  }
  // Legacy trip_requests.tripId is varchar; trips.id is uuid. Convert only the
  // reference, keeping the trip PK index usable. A malformed stored reference
  // must suppress this stale event, not abort the push worker's SQL query.
  const rows: { selectedAt: Date | string | null }[] = await manager.query(`SELECT r."selectedAt" FROM trip_requests r
    LEFT JOIN trips t ON t.id = CASE
      WHEN r."tripId" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN r."tripId"::uuid ELSE NULL END
    WHERE r.id = $1 AND r."passengerId" = $2 AND r.status = 'driver_selected'
      AND r."selectedDriverId" = $3
      AND ${availableAccountSql('r."passengerId"')} AND ${availableAccountSql('r."selectedDriverId"')}
      AND ($4::uuid IS NULL OR t.id = $4)
      AND (r."tripId" IS NULL OR t.status IN ('upcoming', 'ongoing'))`,
    [data.tripRequestId, notification.userId, data.driverId, data.tripId ?? null]);
  if (!rows.length) return false;
  // selectedAt is a legacy timestamp WITHOUT time zone. Compare the Date
  // decoded by the DB driver, not an implicit PostgreSQL timestamptz cast that
  // depends on the database session's time zone.
  return !data.selectedAt || (rows[0].selectedAt !== null &&
    new Date(rows[0].selectedAt).getTime() === Date.parse(data.selectedAt));
}
