import { Trip, TripStatus } from './entities/trip.entity';

/** Republish a never-started public departure; never reopen historical bookings. */
export function canReprogramTrip(trip: Trip, now = Date.now()): boolean {
  return (
    !trip.isPrivate &&
    !trip.tripRequestId &&
    !trip.startedAt &&
    [TripStatus.PENDING, TripStatus.COMPLETED].includes(trip.status) &&
    new Date(trip.departureDate).getTime() < now
  );
}
