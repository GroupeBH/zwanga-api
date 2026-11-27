import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Point } from 'typeorm';
import type { Trip } from '../trips/entities/trip.entity';
import type { GoogleMapsService } from '../google-maps/google-maps.service';
import { TravelMode } from '../google-maps/dto/google-maps.dto';

export const BOOKING_PICKUP_MAX_DISTANCE_METERS = 100;
type Coordinate = { lat: number; lng: number };
type RouteTrip = Pick<
  Trip,
  'departurePoint' | 'arrivalPoint' | 'tripRequestId'
>;
const R = 6371000;
const rad = Math.PI / 180;
const valid = (p: Coordinate) =>
  Number.isFinite(p.lat) &&
  Number.isFinite(p.lng) &&
  Math.abs(p.lat) <= 90 &&
  Math.abs(p.lng) <= 180;
const fromPoint = (p: Point | null): Coordinate | null => {
  if (p?.type !== 'Point' || !Array.isArray(p.coordinates)) return null;
  const [lng, lat] = p.coordinates;
  return typeof lat === 'number' &&
    typeof lng === 'number' &&
    valid({ lat, lng }) &&
    (lat !== 0 || lng !== 0)
    ? { lat, lng }
    : null;
};

const angularDistance = (a: Coordinate, b: Coordinate) =>
  2 *
  Math.asin(
    Math.sqrt(
      Math.min(
        1,
        Math.sin(((b.lat - a.lat) * rad) / 2) ** 2 +
          Math.cos(a.lat * rad) *
            Math.cos(b.lat * rad) *
            Math.sin(((b.lng - a.lng) * rad) / 2) ** 2,
      ),
    ),
  );
const bearing = (a: Coordinate, b: Coordinate) =>
  Math.atan2(
    Math.sin((b.lng - a.lng) * rad) * Math.cos(b.lat * rad),
    Math.cos(a.lat * rad) * Math.sin(b.lat * rad) -
      Math.sin(a.lat * rad) *
        Math.cos(b.lat * rad) *
        Math.cos((b.lng - a.lng) * rad),
  );

/** Distance to a finite great-circle segment, in metres (not to its vertices). */
export function pickupSegmentDistance(
  point: Coordinate,
  start: Coordinate,
  end: Coordinate,
): number {
  const length = angularDistance(start, end);
  const fromStart = angularDistance(start, point);
  if (length < 1e-12) return fromStart * R;
  const angle = bearing(start, point) - bearing(start, end);
  const along = Math.atan2(
    Math.sin(fromStart) * Math.cos(angle),
    Math.cos(fromStart),
  );
  if (along <= 0) return fromStart * R;
  if (along >= length) return angularDistance(end, point) * R;
  return (
    Math.abs(
      Math.asin(
        Math.max(-1, Math.min(1, Math.sin(fromStart) * Math.sin(angle))),
      ),
    ) * R
  );
}

/** No simplification: a preview polyline can cut corners by more than 100 metres. */
function decodeStep(encoded: string): Coordinate[] | null {
  let index = 0,
    lat = 0,
    lng = 0;
  const result: Coordinate[] = [];
  const delta = () => {
    let value = 0;
    for (let shift = 0; shift <= 25; shift += 5) {
      if (index >= encoded.length) return null;
      const byte = encoded.charCodeAt(index++) - 63;
      if (byte < 0 || byte > 63) return null;
      value += (byte & 31) * 2 ** shift;
      if (byte < 32) return value % 2 ? -(value + 1) / 2 : value / 2;
    }
    return null;
  };
  while (index < encoded.length) {
    const dLat = delta(),
      dLng = delta();
    if (dLat === null || dLng === null) return null;
    lat += dLat;
    lng += dLng;
    const point = { lat: lat / 1e5, lng: lng / 1e5 };
    if (!valid(point)) return null;
    result.push(point);
  }
  return result.length >= 2 ? result : null;
}

export function bookingRouteSignature(trip: RouteTrip): string {
  return JSON.stringify([
    trip.tripRequestId ?? null,
    trip.departurePoint,
    trip.arrivalPoint,
  ]);
}

const unavailable = () =>
  new ServiceUnavailableException({
    code: 'BOOKING_PICKUP_ROUTE_UNAVAILABLE',
    message:
      'Impossible de vérifier le point de récupération sur l’itinéraire. Réessayez dans un instant.',
  });

/** Server-owned route only; no passenger waypoint, current driver position or client polyline. */
export async function assertBookingPickupNearRoute(
  trip: RouteTrip,
  pickupPoint: Point | null,
  maps: Pick<GoogleMapsService, 'getDirections'>,
): Promise<void> {
  // Private trips originate from a passenger request, not a reservation of a published route.
  if (trip.tripRequestId) return;
  const pickup = fromPoint(pickupPoint);
  if (!pickup)
    throw new BadRequestException({
      code: 'BOOKING_PICKUP_LOCATION_REQUIRED',
      message:
        'Choisissez un point de récupération sur la carte pour vérifier sa proximité avec l’itinéraire.',
    });
  const origin = fromPoint(trip.departurePoint),
    destination = fromPoint(trip.arrivalPoint);
  if (!origin || !destination) throw unavailable();
  // The published departure belongs to the route by definition, including legacy bookings.
  if (pickup.lat === origin.lat && pickup.lng === origin.lng) return;
  let directions: Awaited<ReturnType<GoogleMapsService['getDirections']>>;
  try {
    directions = await maps.getDirections(
      { origin, destination, mode: TravelMode.DRIVING, alternatives: false },
      { timeoutMs: 6000 },
    );
  } catch {
    throw unavailable();
  }
  const legs = directions?.routes?.[0]?.legs;
  if (directions?.status !== 'OK' || !legs?.length) throw unavailable();
  let distance = Infinity,
    encodedLength = 0,
    stepsCount = 0;
  for (const leg of legs) {
    if (!leg.steps?.length) throw unavailable();
    for (const step of leg.steps) {
      if (typeof step.polyline !== 'string') throw unavailable();
      encodedLength += step.polyline.length;
      if (encodedLength > 500_000 || ++stepsCount > 10_000) throw unavailable();
      const points = decodeStep(step.polyline);
      if (!points) throw unavailable();
      for (let i = 1; i < points.length; i++) {
        distance = Math.min(
          distance,
          pickupSegmentDistance(pickup, points[i - 1], points[i]),
        );
      }
    }
  }
  if (!Number.isFinite(distance)) throw unavailable();
  // Only a sub-micrometre numerical epsilon: exactly 100 m remains eligible.
  if (distance > BOOKING_PICKUP_MAX_DISTANCE_METERS + 1e-6)
    throw new BadRequestException({
      code: 'BOOKING_PICKUP_OFF_ROUTE',
      maxDistanceMeters: BOOKING_PICKUP_MAX_DISTANCE_METERS,
      distanceMeters: Math.ceil(distance),
      message:
        'Votre point de récupération est à plus de 100 m de l’itinéraire. Choisissez un point plus proche sur la carte.',
    });
}
