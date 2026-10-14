import { In, IsNull, LessThan, Repository } from 'typeorm';
import { Trip, TripStatus } from './entities/trip.entity';
import { Booking, BookingStatus } from '../bookings/entities/booking.entity';
import { lockTripBookingCreation } from '../bookings/bookable-trip-transaction';

/** A single conditional transition owns booking expiry and seat restoration. */
export async function expirePendingTrip(
  repository: Repository<Trip>,
  id: string,
  cutoff: Date,
  now: Date,
) {
  return repository.manager.transaction(async (manager) => {
    await lockTripBookingCreation(manager, id);
    const bookings = manager.getRepository(Booking);
    const trips = manager.getRepository(Trip);
    // Match booking status workflows: booking row(s), then trip. Stable ordering
    // prevents two expiry workers from acquiring the same bookings in reverse.
    const candidates = await bookings.find({
      where: {
        tripId: id,
        status: In([BookingStatus.PENDING, BookingStatus.ACCEPTED]),
      },
      order: { id: 'ASC' },
      lock: { mode: 'pessimistic_write' },
    });
    const transition = await trips.update(
      {
        id,
        status: TripStatus.PENDING,
        startedAt: IsNull(),
        departureDate: LessThan(cutoff),
      },
      { status: TripStatus.COMPLETED, completedAt: now },
    );
    if (transition.affected !== 1) return null;

    if (candidates.length)
      await bookings.update(
        { id: In(candidates.map((booking) => booking.id)) },
        { status: BookingStatus.EXPIRED },
      );
    // Pending requests never consumed seats. Never increment twice or exceed capacity.
    const seats = candidates
      .filter((booking) => booking.status === BookingStatus.ACCEPTED)
      .reduce((sum, booking) => sum + booking.numberOfSeats, 0);
    if (seats > 0)
      await trips
        .createQueryBuilder()
        .update(Trip)
        .set({
          availableSeats: () =>
            'LEAST("totalSeats", "availableSeats" + :restoredSeats)',
        })
        .where('id = :id', { id })
        .setParameter('restoredSeats', seats)
        .execute();
    return {
      bookingIds: candidates.map((booking) => booking.id),
      restoredSeats: seats,
    };
  });
}
