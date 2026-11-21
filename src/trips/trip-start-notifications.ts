import { EntityManager } from 'typeorm';
import { Trip } from './entities/trip.entity';
import { Booking, BookingStatus } from '../bookings/entities/booking.entity';
import { availableAccountSql } from '../users/account-availability';
import { enqueueTransactionalNotifications } from '../notifications/transactional-notification';

/** Called inside the start/resume transaction. Assigned requests also own an accepted booking. */
export async function enqueueTripStartNotifications(
  manager: EntityManager,
  trip: Trip,
  transitionId: string,
) {
  const bookings = await manager
    .getRepository(Booking)
    .createQueryBuilder('booking')
    .select(['booking.id', 'booking.passengerId'])
    .where('booking.tripId = :tripId AND booking.status = :status', {
      tripId: trip.id,
      status: BookingStatus.ACCEPTED,
    })
    .andWhere('booking.passengerId <> :driverId', { driverId: trip.driverId })
    .andWhere(availableAccountSql('booking."passengerId"'))
    .orderBy('booking.id', 'ASC')
    .getMany();
  const recipients = [
    ...new Map(
      bookings.map((booking) => [booking.passengerId, booking]),
    ).values(),
  ];
  for (let offset = 0; offset < recipients.length; offset += 100) {
    await enqueueTransactionalNotifications(
      manager,
      recipients.slice(offset, offset + 100).map((booking) => ({
        eventKey: `trip-start:${trip.id}:${transitionId}:${booking.passengerId}`,
        userId: booking.passengerId,
        title: 'Votre trajet a démarré',
        body: `Le trajet ${trip.departureLocation} → ${trip.arrivalLocation} vient de démarrer. Préparez-vous !`,
        data: {
          type: 'trip_started',
          tripId: trip.id,
          bookingId: booking.id,
          role: 'passenger',
          departureLocation: trip.departureLocation,
          arrivalLocation: trip.arrivalLocation,
          departureDate: trip.departureDate.toISOString(),
        },
      })),
    );
  }
}
