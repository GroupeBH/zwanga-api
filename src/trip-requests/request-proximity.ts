import { NotFoundException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { NEARBY_DRIVER_RADIUS_METERS } from './dispatch/nearby-driver-policy';
import { USABLE_DRIVER_LOCATION_SQL } from './dispatch/driver-location-policy';
import { requestDriverVisibilitySql } from './target-driver-policy';

/** Internal SQL expressions only; identifiers supplied by clients stay bound parameters.
 * Use one location, never an OR between an old nearby point and a newer distant one.
 * Discovery consent is respected, but durable last-known positions have no age limit.
 */
export const latestDriverPositionSql = (driverId: string) => `(
  SELECT location.position FROM (
    SELECT p.position, p."updatedAt" AS recorded_at, 0 AS priority
    FROM driver_dispatch_presence p
    WHERE p."driverId" = (${driverId})::uuid AND ${USABLE_DRIVER_LOCATION_SQL}
    UNION ALL
    SELECT t."currentLocation", t."lastLocationUpdateAt", 1 AS priority
    FROM trips t LEFT JOIN driver_dispatch_presence p ON p."driverId" = t."driverId"
    WHERE t."driverId" = (${driverId})::uuid AND t.status = 'ongoing'
      AND t."destinationReachedAt" IS NULL AND t."currentLocation" IS NOT NULL
      AND p."discoveryEnabled" IS DISTINCT FROM false
  ) location ORDER BY location.recorded_at DESC NULLS LAST, location.priority DESC LIMIT 1
)`;

export const requestDriverProximitySql = (requestId: string, driverId: string) => `EXISTS (
  SELECT 1 FROM trip_requests nearby_request WHERE nearby_request.id = ${requestId} AND
    ST_DWithin(nearby_request."departurePoint", ${latestDriverPositionSql(driverId)}, ${NEARBY_DRIVER_RADIUS_METERS})
)`;

export const nearbyRequestDriverVisibilitySql = (requestId: string, driverId: string) =>
  `${requestDriverVisibilitySql(requestId, driverId)} AND ${requestDriverProximitySql(requestId, driverId)}`;

/** Recheck before exposing contact details or committing a new pickup. Existing
 * assignments/history are deliberately not gated by the driver's current position. */
export async function assertRequestDriverProximity(manager: EntityManager, requestId: string, driverId: string) {
  const rows = await manager.query(`SELECT 1 WHERE ${requestDriverProximitySql('$1', '$2')}`, [requestId, driverId]);
  if (!rows.length) throw new NotFoundException('Cette demande est hors de votre zone de prise en charge. Actualisez votre position.');
}
