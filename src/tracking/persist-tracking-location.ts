import type { DataSource } from 'typeorm';

type Sql = Pick<DataSource, 'query'>;
type Position = { tripId: string; ownerId: string; longitude: number; latitude: number; observedAt: Date };

// One statement: a queue failure rolls back the GPS update as well. Ownership,
// state and timestamp predicates remain in SQL, not in a cache.
export async function persistDriverLocation(db: Sql, position: Position): Promise<boolean> {
  const rows = await db.query(`WITH changed AS (
    UPDATE trips SET "currentLocation"=ST_SetSRID(ST_MakePoint($3,$4),4326)::geography,
      "lastLocationUpdateAt"=$5, "updatedAt"=CURRENT_TIMESTAMP
    WHERE id=$1 AND "driverId"=$2 AND status='ongoing'
      AND ("lastLocationUpdateAt" IS NULL OR "lastLocationUpdateAt" < $5)
    RETURNING id AS "tripId"
  ), queued AS (
    INSERT INTO ride_progress_jobs("tripId") SELECT "tripId" FROM changed
    ON CONFLICT("tripId") DO UPDATE SET version=ride_progress_jobs.version+1
    RETURNING "tripId"
  ) SELECT "tripId" FROM queued`,
  [position.tripId, position.ownerId, position.longitude, position.latitude, position.observedAt]);
  return rows.length === 1;
}

export async function persistPassengerLocation(db: Sql, position: Position & { bookingId: string }): Promise<boolean> {
  // Match lifecycle transitions: booking -> trip -> durable job. Never touch
  // the trip before locking its booking (completion takes the same order).
  const rows = await db.query(`WITH changed AS (
    UPDATE bookings SET "passengerCurrentLocation"=ST_SetSRID(ST_MakePoint($3,$4),4326)::geography,
      "passengerLastLocationUpdateAt"=$5, "updatedAt"=CURRENT_TIMESTAMP
    WHERE id=$1 AND "passengerId"=$2 AND "tripId"=$6 AND status IN ('accepted','no_show')
      AND ("passengerLastLocationUpdateAt" IS NULL OR "passengerLastLocationUpdateAt" < $5)
    RETURNING "tripId"
  ), touched AS (
    UPDATE trips t SET "updatedAt"=CURRENT_TIMESTAMP
    FROM changed WHERE t.id=changed."tripId"
    RETURNING t.id AS "tripId"
  ), queued AS (
    INSERT INTO ride_progress_jobs("tripId") SELECT "tripId" FROM touched
    ON CONFLICT("tripId") DO UPDATE SET version=ride_progress_jobs.version+1
    RETURNING "tripId"
  ) SELECT "tripId" FROM queued`,
  [position.bookingId, position.ownerId, position.longitude, position.latitude, position.observedAt, position.tripId]);
  return rows.length === 1;
}
