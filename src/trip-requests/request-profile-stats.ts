import type { EntityManager } from 'typeorm';
import { ACCEPTED_REQUEST_EXPIRATION_MS, UNACCEPTED_REQUEST_EXPIRATION_MS } from './request-edit-policy';

/** Summary-only read: never hydrate an entire passenger/driver history for badges. */
export async function requestProfileStats(manager: EntityManager, userId: string) {
  const now = Date.now();
  const [row] = await manager.query(`WITH effective AS (SELECT r.id,
    CASE WHEN r.status IN ('pending','offers_received','driver_selected') AND r."departureDateMax" <=
      CASE WHEN r.status='driver_selected' OR r."selectedDriverId" IS NOT NULL OR r."tripId" IS NOT NULL
        OR EXISTS (SELECT 1 FROM driver_offers o WHERE o."tripRequestId"=r.id AND o.status='accepted')
      THEN $3::timestamp ELSE $2::timestamp END THEN 'expired' ELSE r.status::text END AS status
    FROM trip_requests r WHERE r."passengerId"=$1)
    SELECT count(*)::int AS "totalRequests",
    count(*) FILTER (WHERE status IN ('pending','offers_received'))::int AS "activeRequests",
    count(*) FILTER (WHERE status='offers_received'
      AND EXISTS (SELECT 1 FROM driver_offers o WHERE o."tripRequestId"=r.id))::int AS "requestsWithOffers",
    count(*) FILTER (WHERE status='driver_selected')::int AS "completedRequests",
    (SELECT count(*)::int FROM driver_offers WHERE "driverId"=$1 AND status='pending') AS "pendingOffersCount"
    FROM effective r`, [userId, new Date(now - UNACCEPTED_REQUEST_EXPIRATION_MS), new Date(now - ACCEPTED_REQUEST_EXPIRATION_MS)]);
  return row as { totalRequests: number; activeRequests: number; requestsWithOffers: number; completedRequests: number; pendingOffersCount: number };
}
