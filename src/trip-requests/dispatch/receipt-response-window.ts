import type { EntityManager } from 'typeorm';
import { REQUEST_RESPONSE_MS } from './sequential-policy';
import { acknowledgeNearbyRequest, acknowledgeNearbyRequestSql } from '../../notifications/nearby-request-cooldown';
import { recordRideNotificationReceipt, rideReceiptParameters, rideReceiptRecordedSql, type RideReceiptDetail } from '../../notifications/ride-notification-receipt';

type ReceiptResult = { received: boolean; responseWindow?: { offerId: string; expiresAt: string; serverNow: string } };

/** Request -> offer lock order matches allocation/retirement. An authenticated
 * first receipt may start the response window, never revive/renew an invitation.
 * Device clocks and repeated/audio receipts cannot extend the lease. */
async function lockReceiptRequest(manager: EntityManager, userId: string, notificationId: string) {
  // Resolve the owned notification and acquire the request lock in one trip.
  // CASE protects casts even if the planner reorders predicates on legacy JSON.
  // Keep offer locking in the NEXT statement: it needs a fresh snapshot after
  // waiting for an acceptance/cancellation holding the request lock.
  const uuid = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  const [request] = await manager.query(`SELECT r.id, r."departureDateMax", n.data->>'offerId' AS "offerId"
    FROM notifications n JOIN trip_requests r ON r.id=CASE
      WHEN n.data->>'tripRequestId' ~* $3 THEN (n.data->>'tripRequestId')::uuid END
    WHERE n.id=$1 AND n."userId"=$2 AND n."isActive"=true
      AND n.data->>'type' IN ('driver_dispatch_offer','trip_request_nearby')
      AND n."eventKey" = 'sequential-offer:' || (n.data->>'offerId')
      AND n.data->>'offerId' ~* $3
      AND r.status IN ('pending','offers_received') AND r."selectedDriverId" IS NULL
      AND r."tripId" IS NULL AND r."targetDriverPriorityUntil" IS NULL AND r."departureDateMax">clock_timestamp()
    FOR SHARE OF r`, [notificationId, userId, uuid]);
  return request;
}

// Only internal parameter placeholders; no client-provided SQL expressions.
// SHARE lets different drivers receive a wave concurrently, but still excludes
// request UPDATE/DELETE and the exclusive allocation/acceptance/retirement lock.
// Never upgrade it in the receipt transaction (request -> offer -> telemetry).
// Keep it in a preceding statement so a wait for a business transaction is
// followed by a fresh offer snapshot. The offer's exclusive lock serializes
// same-driver retries; they return the first deadline without extending it.
const responseWindowCtes = (offer: string, request: string, user: string, duration: string, deadline: string) => `
  WITH eligible AS MATERIALIZED (
    SELECT id, "expiresAt", "deliveryDeadlineAt", "responseStartedAt"
    FROM trip_request_dispatch_offers WHERE id=${offer} AND "requestId"=${request} AND "driverId"=${user}
      AND sequential=true AND status='pending' AND phase='driver' AND "expiresAt">clock_timestamp()
      AND "deliveryDeadlineAt" IS NOT NULL FOR UPDATE
  ), started AS (
    UPDATE trip_request_dispatch_offers o
    SET "responseStartedAt"=clock_timestamp(), "expiresAt"=LEAST(clock_timestamp()+${duration}*interval '1 millisecond',
      e."deliveryDeadlineAt"+${duration}*interval '1 millisecond', ${deadline}::timestamptz)
    FROM eligible e WHERE o.id=e.id AND e."responseStartedAt" IS NULL AND e."deliveryDeadlineAt">clock_timestamp()
    RETURNING o.id, o."expiresAt"
  ), response_window AS MATERIALIZED (
    SELECT id,"expiresAt" FROM started
    UNION ALL SELECT id,"expiresAt" FROM eligible WHERE "responseStartedAt" IS NOT NULL
  )`;

/** Window-only primitive retained for existing callers; same locks and SQL as
 * the combined receipt workflow, without creating telemetry as a side effect. */
export async function startReceivedResponseWindow(manager: EntityManager, userId: string, notificationId: string) {
  const request = await lockReceiptRequest(manager, userId, notificationId);
  if (!request) return;
  const [offer] = await manager.query(`${responseWindowCtes('$1', '$2', '$3', '$4', '$5')}
    SELECT id, "expiresAt" FROM response_window`,
    [request.offerId, request.id, userId, REQUEST_RESPONSE_MS, request.departureDateMax]);
  if (!offer) return;
  return { offerId: offer.id as string, expiresAt: new Date(offer.expiresAt).toISOString(), serverNow: new Date().toISOString() };
}

export async function acknowledgeDispatchNotification(manager: EntityManager, userId: string, notificationId: string,
  stage: 'received' | 'displayed' = 'received', detail?: RideReceiptDetail): Promise<ReceiptResult> {
  const request = await lockReceiptRequest(manager, userId, notificationId);
  if (!request) {
    const receipt = await recordRideNotificationReceipt(manager, userId, notificationId, stage, detail);
    // Without the request SHARE lock, cancellation may commit during a receipt
    // conflict wait. Legacy telemetry therefore requires a NEW statement snapshot.
    if (receipt.received) await acknowledgeNearbyRequest(manager, userId, notificationId);
    return receipt;
  }
  const [receipt] = await manager.query(`${responseWindowCtes('$10', '$11', '$2', '$12', '$13')}, recorded AS (
    ${rideReceiptRecordedSql(true)}
  ), ringing AS (
    ${acknowledgeNearbyRequestSql('$2', '$1')}
      AND EXISTS (SELECT 1 FROM recorded) AND EXISTS (SELECT 1 FROM response_window)
    RETURNING e."notificationId"
  ) SELECT r."notificationId", w.id AS "offerId", w."expiresAt"
    FROM recorded r LEFT JOIN response_window w ON true`,
    [...rideReceiptParameters(userId, notificationId, stage, detail),
      request.offerId, request.id, REQUEST_RESPONSE_MS, request.departureDateMax]);
  // RETURNING carries the updated deadline: sibling CTEs see the old snapshot.
  // Dependencies enforce offer -> telemetry -> ringing. No lock is held across
  // network calls and the caller still commits/rolls back all three atomically.
  if (!receipt) return { received: false };
  if (!receipt.offerId) {
    await acknowledgeNearbyRequest(manager, userId, notificationId);
    return { received: true };
  }
  return { received: true, responseWindow: { offerId: receipt.offerId,
    expiresAt: new Date(receipt.expiresAt).toISOString(), serverNow: new Date().toISOString() } };
}
