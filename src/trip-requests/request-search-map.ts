import { NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { EntityManager } from 'typeorm';
import { TripRequest } from './entities/trip-request.entity';
import { ELIGIBLE_DRIVER_ACCOUNT_SQL, NEARBY_DRIVER_RADIUS_METERS } from './dispatch/nearby-driver-policy';
import { driverRequestConflictSql } from './dispatch/driver-schedule-policy';
import { USABLE_DRIVER_LOCATION_SQL } from './dispatch/driver-location-policy';
import { requestNotRefusedSql } from './request-refusal';

/** Owner-only last-known positions. Marker IDs are scoped to this request, not user IDs. */
export async function requestSearchMap(manager: EntityManager, passengerId: string, requestId: string) {
  const request = await manager.getRepository(TripRequest).findOne({ where: { id: requestId, passengerId } });
  if (!request) throw new NotFoundException('Commande introuvable.');
  const base = { requestId, radiusKm: NEARBY_DRIVER_RADIUS_METERS / 1000, generatedAt: new Date().toISOString() };
  const searching = ['pending', 'offers_received'].includes(request.status) && !request.selectedDriverId && !request.tripId &&
    new Date(request.departureDateMax).getTime() > Date.now();
  if (!searching || !request.departurePoint) return { ...base, searching, groups: [], vehicles: [], total: 0, truncated: false };
  // The shared location policy honors explicit opt-outs and durable last-known positions.
  // ST_DWithin retains the geography index; cap native markers without merging vehicles.
  const rows = await requestMapCandidates(manager, passengerId, requestId);
  const vehicles = rows.slice(0, 500).map(row => ({
    id: requestMapMarkerId(requestId, row.markerSeed),
    latitude: Number(row.latitude), longitude: Number(row.longitude), vehicleType: row.vehicleType,
    positionUpdatedAt: new Date(row.positionUpdatedAt).toISOString(),
  }));
  // Keep the previous contract for old clients, with its original recent-only rule.
  const groups = new Map<string, { id: string; latitude: number; longitude: number; count: number }>();
  for (const vehicle of vehicles) {
    if (Date.parse(base.generatedAt) - Date.parse(vehicle.positionUpdatedAt) > 600000) continue;
    const latitude = Number((Math.round(vehicle.latitude / 0.005) * 0.005).toFixed(3));
    const longitude = Number((Math.round(vehicle.longitude / 0.005) * 0.005).toFixed(3));
    const id = `${latitude}:${longitude}`, group = groups.get(id) ?? { id, latitude, longitude, count: 0 };
    group.count++;
    groups.set(id, group);
  }
  return { ...base, searching, total: vehicles.length, vehicles, truncated: rows.length > 500, groups: [...groups.values()] };
}

export const requestMapMarkerId = (requestId: string, vehicleId: string) => createHash('sha256').update(`${requestId}:${vehicleId}`).digest('hex');

/** Internal rows only. Never return driver IDs in the public map response. */
export function requestMapCandidates(manager: EntityManager, passengerId: string, requestId: string) {
  return manager.query<{ latitude: number; longitude: number; markerSeed: string; vehicleType: string;
    positionUpdatedAt: Date; driverId: string; seats: number }[]>(`
    SELECT ST_Y(p.position::geometry)::float8 AS latitude, ST_X(p.position::geometry)::float8 AS longitude,
      v.id AS "markerSeed", v.type AS "vehicleType", p."updatedAt" AS "positionUpdatedAt", p."driverId",
      CASE WHEN v.id=p."vehicleId" THEN p.seats WHEN v.type='motorcycle_2_wheels' THEN 2
        WHEN v.type='motorcycle_3_wheels' THEN 3 ELSE 4 END AS seats
    FROM driver_dispatch_presence p
    JOIN trip_requests r ON r.id = $1::uuid AND r."passengerId" = $2::uuid
    JOIN LATERAL (SELECT v.* FROM vehicles v WHERE v."ownerId" = p."driverId" AND v."isActive" = true AND v.type = r."vehicleType"
      ORDER BY (v.id = p."vehicleId") DESC, v."updatedAt" DESC, v.id LIMIT 1) v ON true
    WHERE r.status IN ('pending','offers_received') AND r."selectedDriverId" IS NULL AND r."tripId" IS NULL
      AND r."departureDateMax" > now()
      AND p."driverId" <> r."passengerId" AND ${USABLE_DRIVER_LOCATION_SQL} AND ${ELIGIBLE_DRIVER_ACCOUNT_SQL}
      AND NOT ${driverRequestConflictSql('p."driverId"', 'r.id')}
      AND p."updatedAt" <= now() + interval '1 minute'
      AND (r."targetDriverId" IS NULL OR p."driverId" = r."targetDriverId")
      AND ${requestNotRefusedSql('r.id', 'p."driverId"')}
      AND (CASE WHEN v.id = p."vehicleId" THEN p.seats WHEN v.type = 'motorcycle_2_wheels' THEN 2
        WHEN v.type = 'motorcycle_3_wheels' THEN 3 ELSE 4 END) >= r."numberOfSeats"
      AND NOT EXISTS (SELECT 1 FROM trip_request_dispatch_offers o WHERE o."driverId" = p."driverId"
        AND o."requestId" <> r.id AND o.status = 'pending' AND o."expiresAt" > now())
      AND ST_DWithin(p.position, r."departurePoint", $3)
    ORDER BY ST_Distance(p.position, r."departurePoint"), p."driverId" LIMIT 501`, [requestId, passengerId, NEARBY_DRIVER_RADIUS_METERS]);
}
