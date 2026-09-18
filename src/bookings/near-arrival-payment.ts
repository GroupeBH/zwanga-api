import type { Point } from 'typeorm';
import type { Booking } from './entities/booking.entity';
import { hasRideDispute } from '../ride-declarations/ride-declaration.model';

export const EARLY_PAYMENT_DISTANCE_METERS = 500;
export const EARLY_PAYMENT_LOCATION_MAX_AGE_MS = 30_000;

function validPoint(point?: Point | null): point is Point {
  const coordinates = point?.coordinates;
  return Boolean(coordinates && coordinates.length >= 2 &&
    Number.isFinite(coordinates[0]) && Math.abs(coordinates[0]) <= 180 &&
    Number.isFinite(coordinates[1]) && Math.abs(coordinates[1]) <= 90 &&
    !(Math.abs(coordinates[0]) < 0.0001 && Math.abs(coordinates[1]) < 0.0001));
}

function isNearDestination(point: Point | null, timestamp: Date | string | null, destination: Point, now: number) {
  if (!validPoint(point) || !timestamp) return false;
  const age = now - new Date(timestamp).getTime();
  if (!Number.isFinite(age) || age < -5000 || age > EARLY_PAYMENT_LOCATION_MAX_AGE_MS) return false;
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const [lng, lat] = point.coordinates;
  const [destinationLng, destinationLat] = destination.coordinates;
  const a = Math.sin(radians(destinationLat - lat) / 2) ** 2 +
    Math.cos(radians(lat)) * Math.cos(radians(destinationLat)) *
    Math.sin(radians(destinationLng - lng) / 2) ** 2;
  const distance = 6_371_000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
  return distance <= EARLY_PAYMENT_DISTANCE_METERS + 0.000001;
}

/** Only server-persisted boarding and GPS evidence can authorize an early debit. */
export function canPayNearArrival(booking: Booking, now = Date.now()): boolean {
  if (booking.status !== 'accepted' || booking.trip?.status !== 'ongoing' ||
      !['electronic', 'points'].includes(booking.paymentMode) ||
      !(booking.pickedUp || booking.pickedUpAt) || hasRideDispute(booking.rideDeclarations)) return false;
  const destination = booking.passengerDestinationPoint ?? booking.trip.arrivalPoint;
  if (!validPoint(destination)) return false;
  return isNearDestination(booking.passengerCurrentLocation, booking.passengerLastLocationUpdateAt, destination, now) ||
    isNearDestination(booking.trip.currentLocation, booking.trip.lastLocationUpdateAt, destination, now);
}
