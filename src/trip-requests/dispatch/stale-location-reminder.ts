import type { EntityManager } from 'typeorm';
import type { Notification } from '../../notifications/entities/notification.entity';
import { enqueueTransactionalNotification } from '../../notifications/transactional-notification';
import { ELIGIBLE_NEARBY_DRIVER_SQL } from './nearby-driver-policy';

/** Five-minute cron, at most 100 recipients per run; no GPS coordinates in the push. */
export async function enqueueStaleLocationReminders(manager: EntityManager): Promise<number> {
  const rows: { driverId: string; updatedAt: Date }[] = await manager.query(`
    SELECT p."driverId", p."updatedAt" FROM driver_dispatch_presence p
    WHERE p."updatedAt" < now() - interval '6 hours' AND p."locationReminderSentAt" IS NULL
      AND p."discoveryEnabled" = true
      AND ${ELIGIBLE_NEARBY_DRIVER_SQL}
      AND EXISTS (SELECT 1 FROM vehicles v WHERE v."ownerId" = p."driverId" AND v."isActive" = true)
    ORDER BY p."updatedAt", p."driverId" LIMIT 100 FOR UPDATE OF p SKIP LOCKED`);
  for (const row of rows) {
    const updatedAt = new Date(row.updatedAt).toISOString();
    await enqueueTransactionalNotification(manager, {
      eventKey: `driver-location-stale:${row.driverId}:${updatedAt}`, userId: row.driverId,
      title: 'Recevez les commandes près de vous',
      body: 'Votre dernière position connue date de plus de 6 heures. Actualisez-la dans Zwanga pour recevoir des commandes correspondant à votre position actuelle.',
      data: { type: 'driver_location_stale', role: 'driver', driverId: row.driverId,
        locationUpdatedAt: updatedAt, navigateTo: '/driver-availability' },
    });
    // Same transaction as the outbox. Other workers skip these locked rows.
    // A successful fresh GPS update resets this marker for the next stale period.
    await manager.query(`UPDATE driver_dispatch_presence SET "locationReminderSentAt" = now() WHERE "driverId" = $1`, [row.driverId]);
  }
  return rows.length;
}

/** Suppress queued/retried reminders if GPS recovered, the account changed or a ride started. */
export async function isStaleLocationReminderDeliverable(manager: EntityManager, notification: Notification): Promise<boolean> {
  if (!notification.userId || !notification.data?.locationUpdatedAt ||
      !Number.isFinite(Date.parse(notification.data.locationUpdatedAt))) return false;
  const rows: unknown[] = await manager.query(`SELECT 1 FROM driver_dispatch_presence p
    WHERE p."driverId" = $1 AND date_trunc('milliseconds', p."updatedAt") = $2::timestamptz
      AND p."discoveryEnabled" = true
      AND p."updatedAt" < now() - interval '6 hours' AND p."locationReminderSentAt" IS NOT NULL
      AND ${ELIGIBLE_NEARBY_DRIVER_SQL}`, [notification.userId, notification.data.locationUpdatedAt]);
  return rows.length > 0;
}
