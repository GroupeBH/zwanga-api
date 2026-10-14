import { Repository } from 'typeorm';
import { Trip, TripStatus } from './entities/trip.entity';
import { Booking, BookingStatus } from '../bookings/entities/booking.entity';
import { enqueueTransactionalNotification } from '../notifications/transactional-notification';

export type TripReminderKind = 'departure' | 'expiration';

/** Commit the reminder and its outbox rows together, never a stale Trip snapshot. */
export async function enqueueTripReminder(
  repository: Repository<Trip>,
  id: string,
  kind: TripReminderKind,
  now: Date,
): Promise<boolean> {
  return repository.manager.transaction(async (manager) => {
    const trip = await manager.findOne(Trip, {
      where: { id },
      lock: { mode: 'pessimistic_write' },
    });
    const windowMs = (kind === 'departure' ? 30 : 60) * 60_000;
    if (
      !trip ||
      trip.status !== TripStatus.PENDING ||
      trip.startedAt ||
      trip.departureDate <= now ||
      trip.departureDate.getTime() > now.getTime() + windowMs ||
      (kind === 'departure' && trip.departureReminderNotified)
    )
      return false;
    const bookings = await manager.find(Booking, {
      where: { tripId: id, status: BookingStatus.ACCEPTED },
      select: ['id', 'passengerId'],
      order: { id: 'ASC' },
    });
    const departureDate = trip.departureDate.toISOString();
    const minutes = Math.max(
      0,
      Math.round((trip.departureDate.getTime() - now.getTime()) / 60_000),
    );
    const type =
      kind === 'departure' ? 'trip_departure_reminder' : 'trip_expiring_soon';
    const recipients = new Map<string, string | null>([[trip.driverId, null]]);
    for (const booking of bookings)
      recipients.set(booking.passengerId, booking.id);
    for (const [userId, bookingId] of recipients) {
      const driver = userId === trip.driverId;
      await enqueueTransactionalNotification(manager, {
        eventKey: `${type}:${id}:${departureDate}:${userId}`,
        userId,
        title:
          kind === 'departure'
            ? '⏰ Départ du trajet proche'
            : 'Trajet expirant bientôt',
        body: `${driver ? 'Votre trajet' : 'Le trajet'} de ${trip.departureLocation} à ${trip.arrivalLocation} part dans ${minutes} minute(s).${driver ? '' : ' Préparez-vous !'}`,
        data: {
          type,
          tripId: id,
          bookingId,
          driverId: trip.driverId,
          role: driver ? 'driver' : 'passenger',
          departureDate,
          departureLocation: trip.departureLocation,
          arrivalLocation: trip.arrivalLocation,
          minutesUntilDeparture: minutes,
        },
      });
    }
    if (kind === 'departure') {
      await manager.update(Trip, id, { departureReminderNotified: true });
    }
    return true;
  });
}
