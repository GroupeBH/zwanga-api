import type { EntityManager } from 'typeorm';

/** Separate lease from push HTTP. A dead worker is recoverable while the original ring is live. */
export async function claimRideRealtimeNotifications(manager: EntityManager): Promise<string[]> {
  const rows: { notificationId: string }[] = await manager.query(`
    INSERT INTO ride_realtime_deliveries ("notificationId", "attemptedAt")
    SELECT n.id, clock_timestamp() FROM notifications n
    LEFT JOIN ride_realtime_deliveries d ON d."notificationId" = n.id
    WHERE n."eventKey" IS NOT NULL AND n."isActive" = true
      AND n."createdAt" > now() - interval '30 seconds'
      AND n.data ->> 'type' IN ('driver_dispatch_offer','trip_request_nearby','new_booking')
      AND (d."notificationId" IS NULL OR (d."completedAt" IS NULL AND d."attemptedAt" < now() - interval '5 seconds'))
    ORDER BY n."createdAt", n.id LIMIT 100
    ON CONFLICT ("notificationId") DO UPDATE
      SET "attemptedAt" = EXCLUDED."attemptedAt", attempts = ride_realtime_deliveries.attempts + 1
      WHERE ride_realtime_deliveries."completedAt" IS NULL
        AND ride_realtime_deliveries."attemptedAt" < now() - interval '5 seconds'
    RETURNING "notificationId"`);
  return rows.map(row => row.notificationId);
}
