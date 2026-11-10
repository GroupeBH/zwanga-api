import type { EntityManager } from 'typeorm';
import { REQUEST_RESPONSE_MS } from '../trip-requests/dispatch/sequential-policy';

/** Separate lease from push HTTP. A dead worker is recoverable while the original ring is live. */
export async function claimRideRealtimeNotifications(manager: EntityManager): Promise<string[]> {
  const rows: { notificationId: string }[] = await manager.query(`
    INSERT INTO ride_realtime_deliveries ("notificationId", "attemptedAt")
    SELECT n.id, clock_timestamp() FROM notifications n
    LEFT JOIN ride_realtime_deliveries d ON d."notificationId" = n.id
    WHERE n."eventKey" IS NOT NULL AND n."isActive" = true
      AND n."createdAt" > now() - interval '${Math.max(REQUEST_RESPONSE_MS / 1000, 60)} seconds'
      AND (n.data ->> 'type' NOT IN ('driver_dispatch_offer','trip_request_nearby')
        OR n."createdAt" > now() - interval '${REQUEST_RESPONSE_MS / 1000} seconds')
      AND (n.data ->> 'type' IN ('driver_dispatch_offer','trip_request_nearby','new_booking','driver_booking_payment_confirmed')
        OR (n.data ->> 'type' = 'driver_offer' AND n.data ->> 'ringAlert' = 'counter-offer-v1')
        OR (n.data ->> 'type' = 'offer_accepted' AND n.data ->> 'ringAlert' = 'offer-accepted-v1')
        OR (n.data ->> 'type' IN ('cash_payment_confirmed', 'cash_payment_declared') AND n.data ->> 'role' = 'driver'))
      AND (d."notificationId" IS NULL OR (d."completedAt" IS NULL AND d."attemptedAt" < now() - interval '5 seconds'))
    ORDER BY n."createdAt", n.id LIMIT 100
    ON CONFLICT ("notificationId") DO UPDATE
      SET "attemptedAt" = EXCLUDED."attemptedAt", attempts = ride_realtime_deliveries.attempts + 1
      WHERE ride_realtime_deliveries."completedAt" IS NULL
        AND ride_realtime_deliveries."attemptedAt" < now() - interval '5 seconds'
    RETURNING "notificationId"`);
  return rows.map(row => row.notificationId);
}
