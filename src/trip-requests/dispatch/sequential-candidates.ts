import type { EntityManager } from 'typeorm';
import { TripRequest } from '../entities/trip-request.entity';
import { requestDriverVisibilitySql } from '../target-driver-policy';
import { USABLE_DRIVER_LOCATION_SQL } from './driver-location-policy';
import { ELIGIBLE_NEARBY_DRIVER_SQL, NEARBY_DRIVER_RADIUS_METERS } from './nearby-driver-policy';

export interface QueueCandidate { driverId: string; vehicleId: string; seats: number }
/** Bounded nearest-first window; subsequent windows exclude every durable past invitation. */
export async function sequentialCandidates(manager: EntityManager, request: TripRequest, driverId?: string): Promise<QueueCandidate[]> {
  if (!request.departurePoint) return [];
  return manager.query(`SELECT p."driverId", v.id AS "vehicleId",
    CASE WHEN v.id = p."vehicleId" THEN p.seats WHEN v.type = 'motorcycle_2_wheels' THEN 2
      WHEN v.type = 'motorcycle_3_wheels' THEN 3 ELSE 4 END AS seats
    FROM driver_dispatch_presence p
    JOIN LATERAL (SELECT * FROM vehicles v WHERE v."ownerId" = p."driverId" AND v."isActive" = true
      AND v.type = $2 ORDER BY (v.id = p."vehicleId") DESC, v.id LIMIT 1) v ON true
    WHERE ${USABLE_DRIVER_LOCATION_SQL} AND p."driverId" <> $1
      AND ($8::uuid IS NULL OR p."driverId" = $8)
      AND (CASE WHEN v.id = p."vehicleId" THEN p.seats WHEN v.type = 'motorcycle_2_wheels' THEN 2
        WHEN v.type = 'motorcycle_3_wheels' THEN 3 ELSE 4 END) >= $3
      AND (EXISTS (SELECT 1 FROM trip_requests target WHERE target.id = $7 AND target."targetDriverId" = p."driverId")
        OR ST_DWithin(p.position, ST_SetSRID(ST_MakePoint($4,$5),4326)::geography, $6))
      AND ${requestDriverVisibilitySql('$7', 'p."driverId"')}
      AND ${ELIGIBLE_NEARBY_DRIVER_SQL}
      AND NOT EXISTS (SELECT 1 FROM trip_request_dispatch_offers o WHERE o."requestId" = $7 AND o."driverId" = p."driverId")
      AND NOT EXISTS (SELECT 1 FROM trip_request_dispatch_offers o WHERE o."driverId" = p."driverId" AND o.status = 'pending')
    ORDER BY ST_Distance(p.position, ST_SetSRID(ST_MakePoint($4,$5),4326)::geography), p."driverId"
    LIMIT 50 ${driverId ? 'FOR UPDATE OF p SKIP LOCKED' : ''}`,
    [request.passengerId, request.vehicleType, request.numberOfSeats, ...request.departurePoint.coordinates,
      NEARBY_DRIVER_RADIUS_METERS, request.id, driverId ?? null]);
}
