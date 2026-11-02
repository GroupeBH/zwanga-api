import type { EntityManager } from 'typeorm';
import { REQUEST_RESPONSE_MS } from './sequential-policy';

/** Request -> offer lock order matches allocation/retirement. An authenticated
 * first receipt may start the response window, never revive/renew an invitation.
 * Device clocks and repeated/audio receipts cannot extend the lease. */
export async function startReceivedResponseWindow(manager: EntityManager, userId: string, notificationId: string) {
  const [notification] = await manager.query(`SELECT n.data->>'tripRequestId' AS "requestId", n.data->>'offerId' AS "offerId"
    FROM notifications n WHERE n.id=$1 AND n."userId"=$2 AND n."isActive"=true
      AND n.data->>'type' IN ('driver_dispatch_offer','trip_request_nearby')
      AND n."eventKey" = 'sequential-offer:' || (n.data->>'offerId')`, [notificationId, userId]);
  // Do not cast arbitrary/legacy notification JSON to UUID in SQL.
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuid.test(notification?.requestId ?? '') || !uuid.test(notification?.offerId ?? '')) return;
  const [request] = await manager.query(`SELECT id, "departureDateMax" FROM trip_requests
    WHERE id=$1 AND status IN ('pending','offers_received') AND "selectedDriverId" IS NULL
      AND "tripId" IS NULL AND "targetDriverPriorityUntil" IS NULL AND "departureDateMax">clock_timestamp()
    FOR UPDATE`, [notification.requestId]);
  if (!request) return;
  const [offer] = await manager.query(`SELECT id, "expiresAt", "deliveryDeadlineAt", "responseStartedAt"
    FROM trip_request_dispatch_offers WHERE id=$1 AND "requestId"=$2 AND "driverId"=$3
      AND sequential=true AND status='pending' AND phase='driver' AND "expiresAt">clock_timestamp()
    FOR UPDATE`, [notification.offerId, request.id, userId]);
  if (!offer?.deliveryDeadlineAt) return; // Pre-upgrade invitations retain their original contract.
  if (!offer.responseStartedAt) {
    const [updated] = await manager.query(`WITH updated AS (UPDATE trip_request_dispatch_offers
      SET "responseStartedAt"=clock_timestamp(), "expiresAt"=LEAST(clock_timestamp()+$2*interval '1 millisecond',
        "deliveryDeadlineAt"+$2*interval '1 millisecond', $3::timestamptz)
      WHERE id=$1 AND "responseStartedAt" IS NULL AND "deliveryDeadlineAt">clock_timestamp()
      RETURNING "expiresAt") SELECT * FROM updated`, [offer.id, REQUEST_RESPONSE_MS, request.departureDateMax]);
    if (!updated) return;
    offer.expiresAt = updated.expiresAt;
  }
  return { offerId: offer.id as string, expiresAt: new Date(offer.expiresAt).toISOString(), serverNow: new Date().toISOString() };
}
