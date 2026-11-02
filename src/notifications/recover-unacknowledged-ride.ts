import type { EntityManager } from 'typeorm';
import { REQUEST_RESPONSE_MS } from '../trip-requests/dispatch/sequential-policy';
/** One retry only for Android v6, whose persistent receiver deduplicates it.
 * No retry of SENT iOS/legacy alerts (could play twice). No new sound deadline. */
export async function recoverUnacknowledgedRides(manager: EntityManager): Promise<number> {
  const rows: { id: string }[] = await manager.query(`WITH candidates AS (
    SELECT n.id FROM notifications n
    WHERE n.status = 'sent' AND n."isActive" = true AND n.data ->> 'nativeDeliveryVersion' = '6'
      AND n."updatedAt" < now() - interval '12 seconds'
      AND n."createdAt" > now() - interval '${Math.max(REQUEST_RESPONSE_MS / 1000, 45)} seconds'
      AND (COALESCE(n.data ->> 'type', '') NOT IN ('driver_dispatch_offer','trip_request_nearby')
        OR n."createdAt" > now() - interval '${REQUEST_RESPONSE_MS / 1000} seconds')
      AND NOT EXISTS (SELECT 1 FROM ride_notification_receipts r WHERE r."notificationId" = n.id AND r."displayedAt" IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM ride_notification_retries r WHERE r."notificationId" = n.id)
    ORDER BY n."updatedAt", n.id LIMIT 25 FOR UPDATE OF n SKIP LOCKED
  ), claimed AS (
    INSERT INTO ride_notification_retries ("notificationId") SELECT id FROM candidates
    ON CONFLICT DO NOTHING RETURNING "notificationId"
  ), updated AS (UPDATE notifications n SET status = 'pending', "errorMessage" = NULL, "updatedAt" = clock_timestamp()
    FROM claimed c WHERE n.id = c."notificationId" RETURNING n.id) SELECT id FROM updated`);
  return rows.length;
}
