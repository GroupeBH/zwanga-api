import { EntityManager } from 'typeorm';
import { Trip, TripStatus } from '../trips/entities/trip.entity';
import { Booking, BookingStatus } from '../bookings/entities/booking.entity';
import { Notification } from './entities/notification.entity';

/** Suppress an old queued reminder after rescheduling, starting or cancelling. */
export async function isTripReminderDeliverable(
  manager: EntityManager,
  notification: Notification,
) {
  if (!notification.userId || !notification.data?.tripId) return false;
  const trip = await manager.findOneBy(Trip, { id: notification.data?.tripId });
  if (
    !trip ||
    trip.status !== TripStatus.PENDING ||
    trip.startedAt ||
    trip.departureDate.getTime() <= Date.now() ||
    trip.departureDate.toISOString() !== notification.data?.departureDate
  )
    return false;
  if (notification.userId === trip.driverId) return true;
  if (!notification.data?.bookingId) return false;
  return !!(await manager.findOneBy(Booking, {
    id: notification.data?.bookingId,
    tripId: trip.id,
    passengerId: notification.userId!,
    status: BookingStatus.ACCEPTED,
  }));
}
