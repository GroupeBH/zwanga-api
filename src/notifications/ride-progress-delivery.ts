import type { EntityManager } from 'typeorm';
import type { Notification } from './entities/notification.entity';
import { availableAccountSql } from '../users/account-availability';

export const AUTOMATIC_RIDE_NOTIFICATION_TYPES = [
  'pickup_confirmed_automatically',
  'dropoff_confirmed_automatically',
  'destination_proximity',
  'passenger_destination_proximity',
];

/** A deferred pickup/proximity alert must not be delivered after the ride ended. */
export async function isRideProgressDeliverable(
  manager: EntityManager,
  notification: Notification,
) {
  const { bookingId, tripId, type } = notification.data ?? {};
  const uuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (
    !notification.userId ||
    typeof bookingId !== 'string' ||
    !uuid.test(bookingId) ||
    typeof tripId !== 'string' ||
    !uuid.test(tripId)
  )
    return false;
  const droppedOff = type === 'dropoff_confirmed_automatically';
  const rows = await manager.query(
    `SELECT 1 FROM bookings b JOIN trips t ON t.id=b."tripId"
    WHERE b.id=$1 AND t.id=$2 AND $3 IN (b."passengerId", t."driverId")
      AND ${availableAccountSql('$3')}
      AND ${
        droppedOff
          ? `b.status='completed' AND t.status IN ('ongoing','completed')`
          : `b.status='accepted' AND t.status='ongoing' AND b."droppedOff"=false
          AND b."droppedOffConfirmedByPassenger"=false
          AND (b."pickedUp"=true OR b."pickedUpConfirmedByPassenger"=true OR b."pickedUpAt" IS NOT NULL OR b."pickedUpConfirmedAt" IS NOT NULL)`
      }
    LIMIT 1`,
    [bookingId, tripId, notification.userId],
  );
  return rows.length > 0;
}
