import { BadRequestException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import type { DriverChoiceQuery } from './dto/driver-choice.dto';
import { ELIGIBLE_NEARBY_DRIVER_SQL, NEARBY_DRIVER_RADIUS_METERS } from './dispatch/nearby-driver-policy';
import { USABLE_DRIVER_LOCATION_SQL } from './dispatch/driver-location-policy';

/** Public choice data only: never expose phone, push token or exact driver coordinates. */
export async function findDriverChoices(manager: EntityManager, passengerId: string, query: DriverChoiceQuery, targetId?: string) {
  const search = query.search?.trim().toLowerCase() ?? '';
  if (search && search.length < 2) return [];
  const pattern = '%' + search.replace(/[!%_]/g, '!$&') + '%';
  return manager.query(`SELECT u.id, concat_ws(' ', u."firstName", u."lastName") AS name,
      concat_ws(' ', v.brand, v.model, v.color) AS vehicle,
      round((ST_Distance(p.position, ST_SetSRID(ST_MakePoint($2,$3),4326)::geography) / 100.0)::numeric) / 10.0 AS "distanceKm"
    FROM driver_dispatch_presence p JOIN users u ON u.id = p."driverId"
    JOIN LATERAL (SELECT v.* FROM vehicles v WHERE v."ownerId" = u.id AND v."isActive" = true AND v.type = $4
      ORDER BY (v.id = p."vehicleId") DESC, v."updatedAt" DESC, v.id LIMIT 1) v ON true
    WHERE u.id <> $1::uuid AND ${USABLE_DRIVER_LOCATION_SQL} AND ${ELIGIBLE_NEARBY_DRIVER_SQL}
      AND (CASE WHEN v.id = p."vehicleId" THEN p.seats WHEN v.type = 'motorcycle_2_wheels' THEN 2
        WHEN v.type = 'motorcycle_3_wheels' THEN 3 ELSE 4 END) >= $5
      AND NOT EXISTS (SELECT 1 FROM trip_request_dispatch_offers o WHERE o."driverId" = u.id AND o.status = 'pending' AND o."expiresAt" > now())
      AND ($6::uuid IS NULL OR u.id = $6::uuid)
      AND ($7 = '' OR lower(concat_ws(' ', u."firstName", u."lastName")) LIKE $8 ESCAPE '!' OR u.id::text = $7)
      AND ST_DWithin(p.position, ST_SetSRID(ST_MakePoint($2,$3),4326)::geography, $9)
    ORDER BY ST_Distance(p.position, ST_SetSRID(ST_MakePoint($2,$3),4326)::geography), u.id LIMIT 20`,
    [passengerId, query.longitude, query.latitude, query.vehicleType, query.seats, targetId ?? null, search, pattern, NEARBY_DRIVER_RADIUS_METERS]);
}

export async function validateTargetDriver(manager: EntityManager, passengerId: string, targetId: string | null | undefined, query: DriverChoiceQuery) {
  if (!targetId) return;
  if (targetId === passengerId || !(await findDriverChoices(manager, passengerId, query, targetId)).length)
    throw new BadRequestException('Ce conducteur ne peut pas recevoir cette demande. Choisissez un autre conducteur ou les conducteurs proches.');
}
