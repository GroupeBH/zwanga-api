import type { EntityManager } from 'typeorm';
import type { Notification } from './entities/notification.entity';

/** A delayed response describes the current decision, never just an old event.
 * Checks run again on every retry, including events from older mobile clients. */
export async function isRideResponseDeliverable(manager: EntityManager, notification: Notification): Promise<boolean> {
  const data = notification.data;
  if (!notification.userId || !data) return false;
  if (data.type === 'booking_response') {
    if (!['accepted', 'rejected'].includes(data.status)) return false;
    const rows = await manager.query(`SELECT 1 FROM bookings b JOIN trips t ON t.id = b."tripId"
      WHERE b.id = $1 AND b."passengerId" = $2 AND b.status = $3
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
