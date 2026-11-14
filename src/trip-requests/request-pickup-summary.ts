import { NotFoundException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import type { GoogleMapsService } from '../google-maps/google-maps.service';
import { TravelMode } from '../google-maps/dto/google-maps.dto';
import { availableAccountSql } from '../users/account-availability';
import {
  ONGOING_DRIVER_POSITION_SQL,
  ONGOING_DRIVER_POSITION_TIME_SQL,
} from './dispatch/driver-location-policy';

export const PICKUP_SUMMARY_SQL = `SELECT r.id, r."selectedDriverId", r."passengerId", r."selectedAt", r."tripId",
  COALESCE(b."passengerOrigin", r."departureLocation") AS location,
  COALESCE(b."passengerOriginReference", r."departureReference") AS reference,
  ST_Y(COALESCE(b."passengerOriginPoint",r."departurePoint")::geometry) AS "pickupLat",
  ST_X(COALESCE(b."passengerOriginPoint",r."departurePoint")::geometry) AS "pickupLng",
  ST_Y((${ONGOING_DRIVER_POSITION_SQL})::geometry) AS "driverLat",
  ST_X((${ONGOING_DRIVER_POSITION_SQL})::geometry) AS "driverLng",
  ${ONGOING_DRIVER_POSITION_TIME_SQL} AS "driverPositionAt",
  ST_Y(b."passengerCurrentLocation"::geometry) AS "passengerLat",
  ST_X(b."passengerCurrentLocation"::geometry) AS "passengerLng",
  b."passengerLastLocationUpdateAt" AS "passengerPositionAt",
  concat_ws(' ',d."firstName",d."lastName") AS "driverName",
  concat_ws(' ',u."firstName",u."lastName") AS "passengerName",
  v.brand, v.model, v.color, v."licensePlate", r."departureDateMin" AS "departureAt",
  CASE WHEN EXISTS (SELECT 1 FROM driver_trip_interruption_requests interruption
    WHERE interruption."tripId"=t.id AND interruption.status='confirmed') THEN 'confirmed' END AS "interruptionStatus"
FROM trip_requests r
JOIN users d ON d.id=CASE WHEN r."selectedDriverId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN r."selectedDriverId"::text::uuid END
JOIN users u ON u.id=r."passengerId"::uuid
LEFT JOIN trips t ON t.id=CASE WHEN r."tripId" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN r."tripId"::uuid END
LEFT JOIN bookings b ON b."tripId"=t.id AND b."passengerId"=u.id
LEFT JOIN driver_dispatch_presence p ON p."driverId"=d.id
LEFT JOIN vehicles v ON v.id=CASE WHEN r."selectedVehicleId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN r."selectedVehicleId"::text::uuid END AND v."ownerId"=d.id
WHERE r.id=$1 AND (r."passengerId"::text=$2::text OR r."selectedDriverId"::text=$2::text) AND r.status='driver_selected'
  AND ${availableAccountSql('d.id')} AND ${availableAccountSql('u.id')}
  AND (r."tripId" IS NULL OR (t."driverId"=d.id AND t.status IN ('upcoming','ongoing')
    AND b.status='accepted' AND NOT b."pickedUp" AND b."pickedUpAt" IS NULL
    AND NOT b."pickedUpConfirmedByPassenger" AND NOT b."droppedOff" AND b."droppedOffAt" IS NULL))
LIMIT 1`;

export interface PickupSummaryRow {
  id: string;
  selectedDriverId: string;
  passengerId: string;
  selectedAt: Date | string;
  tripId: string | null;
  location: string;
  reference: string | null;
  pickupLat: number | null;
  pickupLng: number | null;
  driverLat: number | null;
  driverLng: number | null;
  driverPositionAt: Date | string | null;
  passengerLat: number | null;
  passengerLng: number | null;
  passengerPositionAt: Date | string | null;
  driverName: string;
  passengerName: string;
  brand: string | null;
  model: string | null;
  color: string | null;
  licensePlate: string | null;
  departureAt: Date | string;
  interruptionStatus: string | null;
}

function coordinates(latitude: number | null, longitude: number | null) {
  return typeof latitude === 'number' &&
    Number.isFinite(latitude) &&
    Math.abs(latitude) <= 90 &&
    typeof longitude === 'number' &&
    Number.isFinite(longitude) &&
    Math.abs(longitude) <= 180
    ? { latitude, longitude }
    : null;
}
function freshPosition(
  lat: number | null,
  lng: number | null,
  at: Date | string | null,
  now: number,
) {
  const point = coordinates(lat, lng),
    time = at ? new Date(at).getTime() : NaN;
  return point &&
    Number.isFinite(time) &&
    now - time >= -30_000 &&
    now - time < 120_000
    ? { ...point, updatedAt: new Date(time).toISOString() }
    : null;
}
const fingerprint = (r: PickupSummaryRow) =>
  JSON.stringify([
    r.selectedDriverId,
    r.selectedAt,
    r.tripId,
    r.pickupLat,
    r.pickupLng,
    r.interruptionStatus,
  ]);

/** Participant-only, fresh coordinates; directions never delay acceptance or hold a DB lock. */
export async function requestPickupSummary(
  manager: EntityManager,
  maps: Pick<GoogleMapsService, 'getDirections'>,
  requestId: string,
  userId: string,
) {
  const read = async () =>
    (
      await manager.query<PickupSummaryRow[]>(PICKUP_SUMMARY_SQL, [
        requestId,
        userId,
      ])
    )[0];
  const row = await read();
  if (!row) throw new NotFoundException('Prise en charge indisponible.');
  const pickup = coordinates(row.pickupLat, row.pickupLng);
  const driverPosition = freshPosition(
    row.driverLat,
    row.driverLng,
    row.driverPositionAt,
    Date.now(),
  );
  let estimate: {
    distanceMeters: number;
    durationSeconds: number;
    source: 'google_maps';
    calculatedAt: string;
  } | null = null;
  if (pickup && driverPosition && row.interruptionStatus !== 'confirmed') {
    try {
      const directions = await maps.getDirections(
        {
          origin: {
            lat: driverPosition.latitude,
            lng: driverPosition.longitude,
          },
          destination: { lat: pickup.latitude, lng: pickup.longitude },
          mode: TravelMode.DRIVING,
          departureTime: Math.ceil(Date.now() / 1000),
        },
        { timeoutMs: 5000 },
      );
      const leg = directions.routes[0]?.legs[0];
      const seconds = leg?.durationInTraffic ?? leg?.duration;
      if (
        leg &&
        Number.isFinite(leg.distance) &&
        leg.distance >= 0 &&
        typeof seconds === 'number' &&
        Number.isFinite(seconds) &&
        seconds >= 0
      )
        estimate = {
          distanceMeters: leg.distance,
          durationSeconds: seconds,
          source: 'google_maps',
          calculatedAt: new Date().toISOString(),
        };
    } catch {
      /* No straight-line ETA or fabricated zero when the route provider fails. */
    }
  }
  // Do not disclose a former driver's position if cancellation/reassignment won during the HTTP call.
  const current = await read();
  if (!current || fingerprint(current) !== fingerprint(row))
    throw new NotFoundException(
      'La prise en charge a changé. Actualisez la commande.',
    );
  const now = Date.now();
  const freshDriver = freshPosition(
    current.driverLat,
    current.driverLng,
    current.driverPositionAt,
    now,
  );
  const freshPassenger = freshPosition(
    current.passengerLat,
    current.passengerLng,
    current.passengerPositionAt,
    now,
  );
  if (
    !freshDriver ||
    !freshPosition(row.driverLat, row.driverLng, row.driverPositionAt, now)
  )
    estimate = null;
  const expiresAt = Math.min(
    now + 30_000,
    ...[freshDriver, freshPassenger]
      .filter((p): p is NonNullable<typeof p> => p !== null)
      .map((p) => Date.parse(p.updatedAt) + 120_000),
  );
  return {
    requestId,
    generatedAt: new Date(now).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
    viewerRole: userId === row.selectedDriverId ? 'driver' : 'passenger',
    departureAt: row.departureAt,
    tripId: row.tripId,
    pickup: {
      location: row.location,
      reference: row.reference,
      coordinates: pickup,
    },
    driver: {
      id: row.selectedDriverId,
      name: current.driverName,
      position: freshDriver,
    },
    passenger: {
      id: row.passengerId,
      name: current.passengerName,
      position: freshPassenger,
    },
    vehicle: row.licensePlate
      ? {
          brand: row.brand,
          model: row.model,
          color: row.color,
          licensePlate: row.licensePlate,
        }
      : null,
    estimate,
    status:
      row.interruptionStatus === 'confirmed'
        ? 'paused'
        : !freshDriver
          ? 'waiting_location'
          : estimate
            ? 'estimated'
            : 'unavailable',
  };
}
