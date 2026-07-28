import type { Point } from 'typeorm';

export interface MapCoordinate {
  latitude: number;
  longitude: number;
}

interface CoordinateBounds {
  minLatitude: number;
  maxLatitude: number;
  minLongitude: number;
  maxLongitude: number;
}

export const LIVE_LOCATION_FRESHNESS_MS = 90_000;

const RDC_BOUNDS: CoordinateBounds = {
  minLatitude: -13.5,
  maxLatitude: 5.5,
  minLongitude: 12,
  maxLongitude: 31.5,
};

export const KINSHASA_BOUNDS: CoordinateBounds = {
  minLatitude: -4.7,
  maxLatitude: -4.1,
  minLongitude: 14.95,
  maxLongitude: 15.65,
};

function isFiniteCoordinate(latitude: number, longitude: number): boolean {
  return (
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    !(Math.abs(latitude) < 0.0001 && Math.abs(longitude) < 0.0001) &&
    Math.abs(latitude) <= 90 &&
    Math.abs(longitude) <= 180
  );
}

function isInBounds(
  latitude: number,
  longitude: number,
  bounds: CoordinateBounds,
): boolean {
  return (
    latitude >= bounds.minLatitude &&
    latitude <= bounds.maxLatitude &&
    longitude >= bounds.minLongitude &&
    longitude <= bounds.maxLongitude
  );
}

export function isCoordinateInRdcBounds(coordinate: MapCoordinate): boolean {
  return isInBounds(coordinate.latitude, coordinate.longitude, RDC_BOUNDS);
}

export function isCoordinateInKinshasaBounds(
  coordinate: MapCoordinate,
): boolean {
  return isInBounds(coordinate.latitude, coordinate.longitude, KINSHASA_BOUNDS);
}

export function normalizeLatLngCoordinate(
  latitudeValue: unknown,
  longitudeValue: unknown,
): MapCoordinate | null {
  const latitude = Number(latitudeValue);
  const longitude = Number(longitudeValue);

  if (!isFiniteCoordinate(latitude, longitude)) {
    return null;
  }

  if (isCoordinateInRdcBounds({ latitude, longitude })) {
    return { latitude, longitude };
  }

  if (
    isFiniteCoordinate(longitude, latitude) &&
    isCoordinateInRdcBounds({ latitude: longitude, longitude: latitude })
  ) {
    return { latitude: longitude, longitude: latitude };
  }

  return null;
}

export function normalizeLngLatCoordinates(
  coordinates?: readonly unknown[] | null,
): [number, number] | null {
  if (!Array.isArray(coordinates) || coordinates.length !== 2) {
    return null;
  }

  const normalized = normalizeLatLngCoordinate(coordinates[1], coordinates[0]);
  return normalized ? [normalized.longitude, normalized.latitude] : null;
}

export function buildPointFromCoordinate(
  coordinate?: MapCoordinate | null,
): Point | null {
  if (!coordinate) {
    return null;
  }

  return {
    type: 'Point',
    coordinates: [coordinate.longitude, coordinate.latitude],
  };
}

export function pointToCoordinate(point?: Point | null): MapCoordinate | null {
  if (!point?.coordinates || point.coordinates.length < 2) {
    return null;
  }

  return normalizeLatLngCoordinate(point.coordinates[1], point.coordinates[0]);
}

export function pointToCoordinates(point?: Point | null): [number, number] | null {
  const coordinate = pointToCoordinate(point);
  return coordinate ? [coordinate.longitude, coordinate.latitude] : null;
}

export function isFreshLocationTimestamp(
  updatedAt?: Date | string | null,
  now = new Date(),
  freshnessMs = LIVE_LOCATION_FRESHNESS_MS,
): boolean {
  if (!updatedAt) {
    return false;
  }

  const timestamp = new Date(updatedAt).getTime();
  if (!Number.isFinite(timestamp)) {
    return false;
  }

  return now.getTime() - timestamp <= freshnessMs;
}

export function isKinshasaRoute(route?: {
  departurePoint?: Point | null;
  arrivalPoint?: Point | null;
} | null): boolean {
  if (!route) {
    return false;
  }

  const departure = pointToCoordinate(route.departurePoint);
  const arrival = pointToCoordinate(route.arrivalPoint);

  return Boolean(
    departure &&
      arrival &&
      isCoordinateInKinshasaBounds(departure) &&
      isCoordinateInKinshasaBounds(arrival),
  );
}

export function isCoordinateAllowedForTrip(
  coordinate: MapCoordinate,
  trip?: { departurePoint?: Point | null; arrivalPoint?: Point | null } | null,
): boolean {
  if (!isCoordinateInRdcBounds(coordinate)) {
    return false;
  }

  return !isKinshasaRoute(trip) || isCoordinateInKinshasaBounds(coordinate);
}

export function normalizeCoordinateForTrip(
  latitudeValue: unknown,
  longitudeValue: unknown,
  trip?: { departurePoint?: Point | null; arrivalPoint?: Point | null } | null,
): MapCoordinate | null {
  const coordinate = normalizeLatLngCoordinate(latitudeValue, longitudeValue);
  if (!coordinate || !isCoordinateAllowedForTrip(coordinate, trip)) {
    return null;
  }

  return coordinate;
}

export function normalizeCoordinatesForTrip(
  coordinates: readonly unknown[] | undefined | null,
  trip?: { departurePoint?: Point | null; arrivalPoint?: Point | null } | null,
): [number, number] | null {
  const normalized = normalizeLngLatCoordinates(coordinates);
  if (!normalized) {
    return null;
  }

  const [longitude, latitude] = normalized;
  const coordinate = normalizeCoordinateForTrip(latitude, longitude, trip);
  return coordinate ? [coordinate.longitude, coordinate.latitude] : null;
}
