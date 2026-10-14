import { IsNull, Repository } from 'typeorm';
import {
  SafetyAlert,
  SafetyAlertStatus,
  SafetyAlertType,
} from './entities/safety-alert.entity';
import { EmergencyContact } from './entities/emergency-contact.entity';
import { Trip, TripStatus } from '../trips/entities/trip.entity';
import { Booking, BookingStatus } from '../bookings/entities/booking.entity';
import { enqueueTransactionalNotification } from '../notifications/transactional-notification';

/** One alert per active user/trip/booking scope, across cron workers. */
export async function createPhoneShutdownAlert(
  repository: Repository<SafetyAlert>,
  candidate: SafetyAlert,
  now: Date,
  timeoutMs: number,
): Promise<boolean> {
  return repository.manager.transaction(async (manager) => {
    await manager.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [
        `phone-shutdown:${candidate.userId}:${candidate.tripId ?? ''}:${candidate.bookingId ?? ''}`,
      ],
    );
    const source = await manager.findOneBy(SafetyAlert, { id: candidate.id });
    if (
      !source ||
      source.status !== SafetyAlertStatus.ACTIVE ||
      !source.lastLocationUpdate ||
      now.getTime() - source.lastLocationUpdate.getTime() <= timeoutMs
    )
      return false;
    const booking = source.bookingId
      ? await manager.findOne(Booking, {
          where: { id: source.bookingId },
          relations: ['trip'],
        })
      : null;
    const trip = source.tripId
      ? await manager.findOneBy(Trip, { id: source.tripId })
      : null;
    const active = (value: Trip | null | undefined) =>
      !!value &&
      value.status === TripStatus.ACTIVE &&
      value.departureDate <= now &&
      !value.completedAt;
    if (
      !active(trip) &&
      !(booking?.status === BookingStatus.ACCEPTED && active(booking.trip))
    )
      return false;
    if (
      await manager.findOneBy(SafetyAlert, {
        userId: source.userId,
        tripId: source.tripId ?? IsNull(),
        bookingId: source.bookingId ?? IsNull(),
        type: SafetyAlertType.PHONE_SHUTDOWN,
        status: SafetyAlertStatus.ACTIVE,
      })
    )
      return false;
    const alert = await manager.save(
      SafetyAlert,
      manager.create(SafetyAlert, {
        userId: source.userId,
        tripId: source.tripId,
        bookingId: source.bookingId,
        type: SafetyAlertType.PHONE_SHUTDOWN,
        status: SafetyAlertStatus.ACTIVE,
        message: 'Téléphone éteint brusquement pendant une course active',
        latitude: source.latitude,
        longitude: source.longitude,
        batteryLevel: source.batteryLevel,
        lastLocationUpdate: source.lastLocationUpdate,
      }),
    );
    // Preserve the existing contact-enabled behavior. Actual SMS/calls were not
    // implemented by notifyEmergencyContacts and are deliberately not added here.
    if (
      await manager.count(EmergencyContact, {
        where: { userId: source.userId, isActive: true },
      })
    ) {
      await enqueueTransactionalNotification(manager, {
        eventKey: `safety:${alert.id}:${source.userId}`,
        userId: source.userId,
        title: 'Alerte de sécurité',
        body: 'Téléphone éteint brusquement pendant une course',
        data: {
          alertId: alert.id,
          type: alert.type,
          latitude: source.latitude?.toString() ?? '',
          longitude: source.longitude?.toString() ?? '',
        },
      });
    }
    return true;
  });
}
