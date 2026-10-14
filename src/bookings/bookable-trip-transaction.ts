import { BadRequestException } from '@nestjs/common';
import { EntityManager, Repository } from 'typeorm';
import { Trip, TripStatus } from '../trips/entities/trip.entity';

/** Serializes inserts against the expiry snapshot, before either takes row locks. */
export async function lockTripBookingCreation(
  manager: EntityManager,
  tripId: string,
) {
  await manager.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    `trip-booking-creation:${tripId}`,
  ]);
}

export async function withBookableTrip<T>(
  repository: Repository<Trip>,
  tripId: string,
  seats: number,
  save: (manager: EntityManager, trip: Trip) => Promise<T>,
): Promise<T> {
  return repository.manager.transaction(async (manager) => {
    await lockTripBookingCreation(manager, tripId);
    // Only new bookings are inserted here; existing booking transitions keep
    // their booking -> trip lock order. No geocoding, push or HTTP under this lock.
    const trip = await manager.findOne(Trip, {
      where: { id: tripId },
      lock: { mode: 'pessimistic_write' },
    });
    if (
      !trip ||
      ![TripStatus.PENDING, TripStatus.ACTIVE].includes(trip.status)
    ) {
      throw new BadRequestException(
        'Ce trajet n’est plus disponible. Actualisez les trajets.',
      );
    }
    if (trip.availableSeats < seats) {
      throw new BadRequestException(
        'Les places disponibles ont changé. Actualisez le trajet.',
      );
    }
    return save(manager, trip);
  });
}
