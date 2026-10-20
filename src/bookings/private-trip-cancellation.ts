import { In, Not, Repository } from 'typeorm';
import { Trip, TripStatus } from '../trips/entities/trip.entity';
import { Booking, BookingStatus } from './entities/booking.entity';

/** Serializes closing an empty private trip against a new shared acceptance. */
export async function finishEmptyPrivateTrip(
  repository: Repository<Trip>,
  tripId: string,
  booking: Booking,
) {
  return repository.manager.transaction(async (manager) => {
    const trip = await manager.findOne(Trip, {
      where: { id: tripId },
      lock: { mode: 'pessimistic_write' },
    });
    if (
      !trip?.isPrivate ||
      ![TripStatus.PENDING, TripStatus.ACTIVE].includes(trip.status)
    )
      return null;
    if (
      await manager.exists(Booking, {
        where: {
          tripId,
          id: Not(booking.id),
          status: In([BookingStatus.PENDING, BookingStatus.ACCEPTED]),
        },
      })
    )
      return null;
    const pickedUp = Boolean(
      booking.pickedUp ||
      booking.pickedUpConfirmedByPassenger ||
      booking.pickedUpAt,
    );
    trip.status = pickedUp ? TripStatus.COMPLETED : TripStatus.CANCELLED;
    if (pickedUp) trip.completedAt = new Date();
    await manager.update(Trip, trip.id, {
      status: trip.status,
      ...(pickedUp ? { completedAt: trip.completedAt } : {}),
    });
    return trip;
  });
}
