import { ConflictException, NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { Trip, TripStatus } from './entities/trip.entity';
import { assertTripUpdateSchedule } from '../trip-requests/dispatch/driver-schedule-policy';

// Only fields edited by TripsService.update; never persist its stale relations,
// tracking data, status timestamps, or an unchanged departure from that snapshot.
const DETAIL_FIELDS = [
  'departureDate',
  'departureLocation',
  'departureReference',
  'departurePoint',
  'arrivalLocation',
  'arrivalReference',
  'arrivalPoint',
  'vehicleId',
  'description',
  'totalSeats',
  'availableSeats',
  'pricePerSeat',
  'isFree',
  'requiresPassengerKyc',
  'acceptedPaymentModes',
  'paymentModesExplicit',
  'status',
] as const satisfies readonly (keyof Trip)[];
const equal = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const changed = () =>
  new ConflictException({
    code: 'TRIP_CHANGED',
    message: 'Ce trajet a changé. Actualisez-le avant de le modifier.',
  });

/** Geocoding/validation already done. Serialize the final write with acceptance
 * and publication; never hold a database lock across notifications/network I/O. */
export function saveTripDetailsUpdate(
  repository: Repository<Trip>,
  before: Trip,
  edited: Trip,
): Promise<Trip> {
  const fields = DETAIL_FIELDS.filter(
    (key) => edited[key] !== undefined && !equal(before[key], edited[key]),
  );
  return repository.manager.transaction('READ COMMITTED', async (manager) => {
    // Acceptances lock request -> owner; publications lock owner. We never lock
    // a request here. NO KEY UPDATE permits foreign-key checks on the owner.
    await manager.query('SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE', [
      before.driverId,
    ]);
    const trips = manager.getRepository(Trip);
    const current = await trips.findOne({
      where: { id: before.id, driverId: before.driverId },
      lock: { mode: 'for_no_key_update' },
    });
    if (!current) throw new NotFoundException('Trajet non trouvé');
    if (
      current.status !== before.status ||
      current.tripRequestId !== before.tripRequestId ||
      current.isPrivate !== before.isPrivate ||
      fields.some((key) => !equal(current[key], before[key])) ||
      (fields.includes('totalSeats') &&
        current.availableSeats !== before.availableSeats)
    )
      throw changed();
    if (!fields.length) return current;
    const oldStart = new Date(current.departureDate).getTime();
    const oldEnd = current.estimatedArrivalDate
      ? new Date(current.estimatedArrivalDate).getTime()
      : NaN;
    const updated = Object.assign(
      current,
      Object.fromEntries(fields.map((key) => [key, edited[key]])),
    );
    if (fields.includes('departureDate')) {
      // Preserve the known duration, not the old clock time. Otherwise moving
      // the departure later could silently shorten the protected interval.
      updated.estimatedArrivalDate =
        oldEnd > oldStart
          ? new Date(
              new Date(updated.departureDate).getTime() + oldEnd - oldStart,
            )
          : null;
    }
    if (
      (fields.includes('departureDate') || fields.includes('status')) &&
      [TripStatus.PENDING, TripStatus.ACTIVE].includes(updated.status)
    )
      await assertTripUpdateSchedule(manager, updated);
    return trips.save(updated);
  });
}
