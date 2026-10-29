import type { EntityManager } from 'typeorm';
import { TripRequest } from '../entities/trip-request.entity';
import { requestDriverVisibilitySql } from '../target-driver-policy';
import { ONGOING_DRIVER_POSITION_SQL, USABLE_DRIVER_LOCATION_SQL } from './driver-location-policy';
import { ELIGIBLE_DRIVER_ACCOUNT_SQL, ELIGIBLE_NEARBY_DRIVER_SQL, NEARBY_DRIVER_RADIUS_METERS } from './nearby-driver-policy';

export interface QueueCandidate { driverId: string; vehicleId: string; seats: number; existingTripId: string | null }
/** Only discovery searches/ranks the area. Redis retains this bounded ordering. */
export function sequentialCandidates(manager: EntityManager, request: TripRequest): Promise<QueueCandidate[]> {
  return candidates(manager, request);
}

/** Skip occupied IDs cheaply, then validate just one locked Redis candidate.
 * Returning the checked ID even if ineligible lets the caller try the next without
 * re-running discovery. The caller holds a transaction until the outbox commits. */
export async function lockNextQueuedCandidate(manager: EntityManager, request: TripRequest,
  driverIds: string[]): Promise<{ driverId: string; candidate: QueueCandidate | null } | null> {
  if (!driverIds.length) return null;
  const [row] = await candidates(manager, request, driverIds);
  return row ? { driverId: row.driverId, candidate: row.vehicleId ? row : null } : null;
}

async function candidates(manager: EntityManager, request: TripRequest, driverIds?: string[]): Promise<QueueCandidate[]> {
  if (!request.departurePoint) return [];
  // MATERIALIZED + LIMIT keeps the costly vehicle/KYC/spatial checks downstream
  // of one driver reservation. Busy drivers are skipped using invitation indexes,
  // in Redis order, without doing those checks for the other 49 IDs.
  const queued = driverIds ? `queued_driver AS MATERIALIZED (
    SELECT driver.id FROM unnest($11::uuid[]) WITH ORDINALITY AS q(id, position)
    JOIN users driver ON driver.id = q.id
    WHERE NOT EXISTS (SELECT 1 FROM trip_request_dispatch_offers o WHERE o."requestId" = $7 AND o."driverId" = driver.id)
      AND NOT EXISTS (SELECT 1 FROM trip_request_dispatch_offers o WHERE o."driverId" = driver.id AND o.status = 'pending')
    ORDER BY q.position LIMIT 1 FOR NO KEY UPDATE OF driver SKIP LOCKED
  ),` : '';
  return manager.query(`WITH ${queued} eligible AS (
    SELECT p."driverId", v.id AS "vehicleId",
    CASE WHEN v.id = p."vehicleId" THEN p.seats WHEN v.type = 'motorcycle_2_wheels' THEN 2
      WHEN v.type = 'motorcycle_3_wheels' THEN 3 ELSE 4 END AS seats,
      NULL::uuid AS "existingTripId", p.position
    FROM driver_dispatch_presence p
    JOIN LATERAL (SELECT * FROM vehicles v WHERE v."ownerId" = p."driverId" AND v."isActive" = true
      AND v.type = $2 ORDER BY (v.id = p."vehicleId") DESC, v.id LIMIT 1) v ON true
    WHERE ${USABLE_DRIVER_LOCATION_SQL} AND p."driverId" <> $1
      ${driverIds ? 'AND p."driverId" = (SELECT id FROM queued_driver)' : ''}
      AND (CASE WHEN v.id = p."vehicleId" THEN p.seats WHEN v.type = 'motorcycle_2_wheels' THEN 2
        WHEN v.type = 'motorcycle_3_wheels' THEN 3 ELSE 4 END) >= $3
      AND ST_DWithin(p.position, ST_SetSRID(ST_MakePoint($4,$5),4326)::geography, $6)
      AND ${requestDriverVisibilitySql('$7', 'p."driverId"')}
      AND ${ELIGIBLE_NEARBY_DRIVER_SQL}

    UNION ALL
    SELECT t."driverId", v.id, t."availableSeats", t.id, ${ONGOING_DRIVER_POSITION_SQL}
    FROM trips t
    JOIN vehicles v ON v.id = t."vehicleId"::uuid AND v."ownerId" = t."driverId" AND v."isActive" = true
    LEFT JOIN driver_dispatch_presence p ON p."driverId" = t."driverId"
    WHERE t.status = 'ongoing' AND t."destinationReachedAt" IS NULL
      AND t."driverId" <> $1 AND v.type = $2 AND t."availableSeats" >= $3 AND t."totalSeats" > 0
      ${driverIds ? 'AND t."driverId" = (SELECT id FROM queued_driver)' : ''}
      AND t."totalSeats" <= CASE WHEN v.type = 'motorcycle_2_wheels' THEN 2
        WHEN v.type = 'motorcycle_3_wheels' THEN 3 ELSE 20 END
      AND $8::timestamptz <= now() + interval '10 minutes' AND $9::numeric IS NOT NULL
      AND (t."isFree" = true OR (t."pricePerSeat" >= 0 AND t."pricePerSeat" <= $9
        AND (t."pricePerSeat" = 0 OR $10 = ANY(t."acceptedPaymentModes"))))
      AND p."discoveryEnabled" IS DISTINCT FROM false
      AND ${ELIGIBLE_DRIVER_ACCOUNT_SQL.replaceAll('p."driverId"', 't."driverId"')}
      AND ${requestDriverVisibilitySql('$7', 't."driverId"')}
      AND ST_DWithin(${ONGOING_DRIVER_POSITION_SQL},
        ST_SetSRID(ST_MakePoint($4,$5),4326)::geography, $6)
    )
    ${driverIds ? `SELECT q.id AS "driverId", e."vehicleId", e.seats, e."existingTripId"
    FROM queued_driver q LEFT JOIN eligible e ON e."driverId" = q.id
    ORDER BY e."existingTripId" LIMIT 1` : `SELECT e."driverId", e."vehicleId", e.seats, e."existingTripId"
    FROM eligible e JOIN users driver ON driver.id = e."driverId"
    WHERE NOT EXISTS (SELECT 1 FROM trip_request_dispatch_offers o WHERE o."requestId" = $7 AND o."driverId" = e."driverId")
      AND NOT EXISTS (SELECT 1 FROM trip_request_dispatch_offers o WHERE o."driverId" = e."driverId" AND o.status = 'pending')
    ORDER BY ST_Distance(e.position, ST_SetSRID(ST_MakePoint($4,$5),4326)::geography), e."driverId", e."existingTripId"
    LIMIT 50`}`,
    [request.passengerId, request.vehicleType, request.numberOfSeats, ...request.departurePoint.coordinates,
      NEARBY_DRIVER_RADIUS_METERS, request.id, request.departureDateMin, request.maxPricePerSeat, request.paymentMode,
      ...(driverIds ? [driverIds] : [])]);
}
