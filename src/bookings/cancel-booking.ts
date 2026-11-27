import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type { Repository } from 'typeorm';
import { Booking, BookingStatus } from './entities/booking.entity';
import { Trip } from '../trips/entities/trip.entity';

export function assertBookingCanBeCancelled(
  booking: Booking,
  trip: Trip,
  userId: string,
): void {
  const driver = trip.driverId === userId;
  if (!driver && booking.passengerId !== userId)
    throw new ForbiddenException('Accès refusé');
  if (driver && trip.tripRequestId)
    throw new BadRequestException(
      'Le conducteur doit arrêter la commande avant la prise en charge.',
    );
  if (
    booking.pickedUp ||
    booking.pickedUpAt ||
    booking.pickedUpConfirmedByPassenger ||
    booking.pickedUpConfirmedAt ||
    booking.droppedOff ||
    booking.droppedOffAt ||
    booking.droppedOffConfirmedByPassenger ||
    booking.droppedOffConfirmedAt ||
    booking.rideDeclarations?.pickup?.driver ||
    booking.rideDeclarations?.pickup?.passenger ||
    booking.rideDeclarations?.dropoff?.driver ||
    booking.rideDeclarations?.dropoff?.passenger
  ) {
    throw new BadRequestException({
      code: 'BOOKING_ALREADY_BOARDED',
      message:
        'Impossible d’annuler après une déclaration d’embarquement. Utilisez la demande d’interruption ou contactez l’assistance.',
    });
  }
  if (
    ![BookingStatus.PENDING, BookingStatus.ACCEPTED].includes(booking.status) ||
    (driver && booking.status !== BookingStatus.ACCEPTED)
  ) {
    throw new BadRequestException(
      'Cette réservation ne peut plus être annulée',
    );
  }
}

/** Same trip -> booking order as declarations; no HTTP or refund while holding locks. */
export async function cancelBookingBeforePickup(
  repository: Repository<Booking>,
  id: string,
  userId: string,
  releaseSubsidy: (booking: Booking, trip: Trip) => void,
) {
  const identity = await repository.findOne({
    where: { id },
    select: { id: true, tripId: true },
  });
  if (!identity) throw new NotFoundException('Réservation non trouvée');
  return repository.manager.transaction(async (manager) => {
    const trip = await manager.findOne(Trip, {
      where: { id: identity.tripId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!trip) throw new NotFoundException('Trajet non trouvé');
    const booking = await manager
      .getRepository(Booking)
      .createQueryBuilder('booking')
      .addSelect('booking.rideDeclarations')
      .where('booking.id = :id AND booking.tripId = :tripId', {
        id,
        tripId: trip.id,
      })
      .setLock('pessimistic_write')
      .getOne();
    if (!booking) throw new NotFoundException('Réservation non trouvée');
    assertBookingCanBeCancelled(booking, trip, userId);
    const oldStatus = booking.status;
    booking.status = BookingStatus.CANCELLED;
    booking.cancelledAt = new Date();
    releaseSubsidy(booking, trip);
    await manager.save(Booking, booking);
    return { booking, trip, oldStatus };
  });
}
