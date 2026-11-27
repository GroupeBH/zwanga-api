import type { Point } from 'typeorm';
import type { Booking } from './entities/booking.entity';
import type { Trip } from '../trips/entities/trip.entity';
import type { TrackedLocationPoint } from '../common/services/location-history.service';

export interface ArrivalPrompt {
  id: string;
  proposedAt: string;
  expiresAt: string;
  acceptedAt?: string;
}
export interface ArrivalStop {
  latitude: number;
  longitude: number;
  since: number;
  lastAt: number;
  observations: number;
}
export const ARRIVAL_STOP_MS = 5 * 60_000;
export const ARRIVAL_PROMPT_TTL_MS = 10 * 60_000;
export const ARRIVAL_GPS_MAX_AGE_MS = 45_000;

export function arrivalDistance(
  a: Point | null | undefined,
  b: Point | null | undefined,
): number {
  if (
    ![a, b].every(
      (p) =>
        p?.coordinates?.length === 2 &&
        p.coordinates.every(Number.isFinite) &&
        Math.abs(p.coordinates[0]) <= 180 &&
        Math.abs(p.coordinates[1]) <= 90,
    )
  )
    return Infinity;
  const [lng1, lat1] = a!.coordinates,
    [lng2, lat2] = b!.coordinates,
    rad = Math.PI / 180;
  const h =
    Math.sin(((lat2 - lat1) * rad) / 2) ** 2 +
    Math.cos(lat1 * rad) *
      Math.cos(lat2 * rad) *
      Math.sin(((lng2 - lng1) * rad) / 2) ** 2;
  return 6371000 * 2 * Math.asin(Math.sqrt(Math.min(1, h)));
}
export const arrivalPoint = (
  p: Pick<TrackedLocationPoint, 'longitude' | 'latitude'>,
): Point => ({ type: 'Point', coordinates: [p.longitude, p.latitude] });
export const arrivalDestination = (booking: Booking, trip: Trip) =>
  booking.passengerDestinationPoint ?? trip.arrivalPoint;

/** Sparse/missing telemetry is not proof of immobility. Never advance on duplicates. */
export function observeArrivalStop(
  previous: ArrivalStop | null,
  point: TrackedLocationPoint,
  destination: Point | null,
  now: number,
  notBefore: number,
): ArrivalStop | null {
  const at = Date.parse(point.recordedAt);
  if (
    !Number.isFinite(at) ||
    !Number.isFinite(notBefore) ||
    at < notBefore ||
    at > now ||
    now - at > ARRIVAL_GPS_MAX_AGE_MS ||
    point.accuracyMeters == null ||
    !Number.isFinite(point.accuracyMeters) ||
    point.accuracyMeters < 0 ||
    point.accuracyMeters > 35 ||
    (point.speedMetersPerSecond != null &&
      (!Number.isFinite(point.speedMetersPerSecond) ||
        point.speedMetersPerSecond < 0 ||
        point.speedMetersPerSecond > 0.8)) ||
    arrivalDistance(arrivalPoint(point), destination) > 100
  )
    return null;
  if (previous && at <= previous.lastAt) return previous;
  if (
    !previous ||
    previous.since < notBefore ||
    at - previous.lastAt > ARRIVAL_GPS_MAX_AGE_MS ||
    arrivalDistance(arrivalPoint(point), arrivalPoint(previous)) > 20
  ) {
    return {
      latitude: point.latitude,
      longitude: point.longitude,
      since: at,
      lastAt: at,
      observations: 1,
    };
  }
  return { ...previous, lastAt: at, observations: previous.observations + 1 };
}

export function canAcceptArrivalPrompt(
  booking: Booking,
  trip: Trip,
  now: number,
): boolean {
  const prompt = booking.arrivalPrompt,
    at = new Date(trip.lastLocationUpdateAt ?? NaN).getTime();
  return Boolean(
    prompt &&
    !prompt.acceptedAt &&
    Date.parse(prompt.expiresAt) > now &&
    Date.parse(prompt.proposedAt) <= now &&
    booking.status === 'accepted' &&
    trip.status === 'ongoing' &&
    (booking.pickedUp || booking.pickedUpAt) &&
    !booking.droppedOff &&
    !booking.droppedOffAt &&
    Number.isFinite(at) &&
    at <= now &&
    now - at <= ARRIVAL_GPS_MAX_AGE_MS &&
    arrivalDistance(trip.currentLocation, arrivalDestination(booking, trip)) <=
      200,
  );
}

export function arrivalObservationMatchesTrip(
  point: TrackedLocationPoint | null | undefined,
  trip: Trip,
  now: number,
): boolean {
  if (
    !point ||
    point.accuracyMeters == null ||
    !Number.isFinite(point.accuracyMeters) ||
    point.accuracyMeters < 0 ||
    point.accuracyMeters > 35
  )
    return false;
  const at = Date.parse(point.recordedAt),
    persistedAt = new Date(trip.lastLocationUpdateAt ?? NaN).getTime();
  return (
    Number.isFinite(at) &&
    at >= persistedAt &&
    at <= now &&
    now - at <= ARRIVAL_GPS_MAX_AGE_MS &&
    arrivalDistance(arrivalPoint(point), trip.currentLocation) <= 10
  );
}
