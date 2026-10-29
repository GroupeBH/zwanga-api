import { BadRequestException, NotFoundException } from '@nestjs/common';
import { In, Repository } from 'typeorm';
import { Booking, BookingStatus } from '../bookings/entities/booking.entity';
import { lockTripBookingCreation } from '../bookings/bookable-trip-transaction';
import { Trip, TripStatus } from './entities/trip.entity';

export async function completeTripTransaction(
  repository: Repository<Trip>,
  id: string,
  driverId: string,
  completedAt: Date,
  hasArrived: (booking: Booking) => boolean,
): Promise<boolean> {
  return repository.manager.transaction(async (manager) => {
    // Same ordering as expiry: creation gate -> booking rows -> trip. Pending
    // bookings must also be locked: acceptance can turn one into an active passenger.
    await lockTripBookingCreation(manager, id);
    const bookings = await manager.find(Booking, {
      where: {
        tripId: id,
        status: In([BookingStatus.PENDING, BookingStatus.ACCEPTED]),
      },
      order: { id: 'ASC' },
      lock: { mode: 'pessimistic_write' },
    });
    const trip = await manager.findOne(Trip, {
      where: { id, driverId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!trip) throw new NotFoundException('Trajet non trouvé');
    if (trip.status === TripStatus.COMPLETED) return false;
    if (trip.status !== TripStatus.ACTIVE)
      throw new BadRequestException('Ce trajet ne peut plus être terminé');
    if (
      bookings.some(
        (booking) =>
          booking.status === BookingStatus.ACCEPTED && !hasArrived(booking),
      )
    ) {
      throw new BadRequestException(
        'Impossible de terminer le trajet tant que l’arrivée à destination de tous les passagers acceptés n’a pas été confirmée.',
      );
    }
    await manager.update(
      Trip,
      { id, driverId, status: TripStatus.ACTIVE },
      { status: TripStatus.COMPLETED, completedAt },
    );
    return true;
  });
}
