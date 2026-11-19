import { EntityManager } from 'typeorm';
import { Notification } from './entities/notification.entity';
import { availableAccountSql } from '../users/account-availability';

/** Also rejects legacy global broadcasts still pending when this change is deployed. */
export async function isTripStartDeliverable(
  manager: EntityManager,
  notification: Notification,
): Promise<boolean> {
  const tripId = notification.data?.tripId;
  const uuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!notification.userId || typeof tripId !== 'string' || !uuid.test(tripId))
    return false;
  const rows = await manager.query(
    `SELECT 1 FROM bookings b JOIN trips t ON t.id = b."tripId"
    WHERE t.id = $1 AND t.status = 'ongoing' AND b."passengerId" = $2 AND b.status = 'accepted'
      AND b."passengerId" <> t."driverId"
      AND ${availableAccountSql('b."passengerId"')} AND ${availableAccountSql('t."driverId"')}
    LIMIT 1`,
    [tripId, notification.userId],
  );
  return rows.length > 0;
}
