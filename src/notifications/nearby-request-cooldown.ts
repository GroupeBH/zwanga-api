import { requestDriverVisibilitySql } from '../trip-requests/target-driver-policy';
import { declineRequestForDriver } from '../trip-requests/request-refusal';
import type { EntityManager } from 'typeorm';
import type { Notification } from './entities/notification.entity';

export function isNearbyRingingRequest(
  data?: Record<string, unknown> | null,
): boolean {
  return (
    data?.type === 'trip_request_nearby' ||
    data?.type === 'driver_dispatch_offer'
  );
}

type State = {
  driverId: string;
  missedCount: number;
  mutedUntil: Date | null;
  cycleStartedAt: Date;
  now: Date;
};
type Event = {
  requestId: string;
  createdAt: Date;
  declinedAt: Date | null;
  answered: boolean;
  dispatchDeclined: boolean;
  actionable: boolean;
  receivedAt: Date | null;
  responseDeadline: Date;
};

// Lock order is always state -> events. Never lock a trip/request here, or hold
// a database lock while sending a push. The existing business transactions stay independent.
async function lockState(
  manager: EntityManager,
  driverId: string,
): Promise<State> {
  await manager.query(
    `INSERT INTO nearby_driver_ring_state ("driverId") VALUES ($1) ON CONFLICT DO NOTHING`,
    [driverId],
  );
  const [state]: State[] = await manager.query(
    `SELECT *, clock_timestamp() AS now
    FROM nearby_driver_ring_state WHERE "driverId" = $1 FOR UPDATE`,
    [driverId],
  );
  // Keep the row lock and old response fields for compatible clients, but retire
  // the global penalty, including rows muted before this version was deployed.
  if (state.missedCount !== 0 || state.mutedUntil !== null) {
    await manager.query(
      `UPDATE nearby_driver_ring_state SET "missedCount" = 0, "mutedUntil" = NULL
      WHERE "driverId" = $1`,
      [driverId],
    );
    state.missedCount = 0;
    state.mutedUntil = null;
  }
  return state;
}

async function reconcile(manager: EntityManager, state: State): Promise<void> {
  const events: Event[] = await manager.query(
    `SELECT e."requestId", e."createdAt", e."declinedAt", e."receivedAt", e."responseDeadline",
    (r."selectedDriverId" = e."driverId" OR EXISTS (SELECT 1 FROM driver_offers o
      WHERE o."tripRequestId" = e."requestId" AND o."driverId" = e."driverId") OR
      EXISTS (SELECT 1 FROM trip_request_dispatch_offers o WHERE o."requestId" = e."requestId"
        AND o."driverId" = e."driverId" AND o.status = 'accepted')) AS answered,
    EXISTS (SELECT 1 FROM trip_request_dispatch_offers o WHERE o."requestId" = e."requestId"
      AND o."driverId" = e."driverId" AND o.status = 'declined') AS "dispatchDeclined",
    (r."passengerId" <> e."driverId" AND r.status IN ('pending','offers_received')
      AND r."selectedDriverId" IS NULL AND r."tripId" IS NULL AND r."departureDateMax" > $2) AS actionable
    FROM nearby_driver_ring_events e JOIN trip_requests r ON r.id = e."requestId"
    WHERE e."driverId" = $1 AND e."processedAt" IS NULL
      AND (e."declinedAt" IS NOT NULL OR e."responseDeadline" <= $2 OR EXISTS (
        SELECT 1 FROM trip_request_dispatch_offers o WHERE o."requestId" = e."requestId"
          AND o."driverId" = e."driverId" AND o.status = 'declined'))
    ORDER BY COALESCE(e."declinedAt", e."responseDeadline"), e."requestId" LIMIT 100`,
    [state.driverId, state.now],
  );
  const outcomes: string[] = [];
  for (const event of events) {
    let outcome: string;
    if (
      new Date(event.createdAt).getTime() <
      new Date(state.cycleStartedAt).getTime()
    )
      outcome = 'obsolete';
    else if (event.answered) outcome = 'answered';
    else if (!event.actionable && !event.declinedAt && !event.dispatchDeclined)
      outcome = 'obsolete';
    // Provider acceptance is not proof that a device received an invitation.
    // Keep delivery outcomes for diagnostics, never as a future ringing penalty.
    else if (!event.receivedAt && !event.declinedAt && !event.dispatchDeclined)
      outcome = 'obsolete';
    else if (
      !event.declinedAt &&
      !event.dispatchDeclined &&
      new Date(event.responseDeadline).getTime() -
        new Date(event.receivedAt!).getTime() <
        10_000
    )
      outcome = 'obsolete'; // A late delivery did not leave a fair response window.
    else {
      outcome =
        event.declinedAt || event.dispatchDeclined ? 'declined' : 'ignored';
    }
    outcomes.push(outcome);
  }
  if (events.length)
    await manager.query(
      `UPDATE nearby_driver_ring_events e SET "processedAt" = $4, outcome = v.outcome
    FROM unnest($2::uuid[], $3::text[]) AS v("requestId", outcome)
    WHERE e."driverId" = $1 AND e."requestId" = v."requestId" AND e."processedAt" IS NULL`,
      [
        state.driverId,
        events.map((event) => event.requestId),
        outcomes,
        state.now,
      ],
    );
}

/** Runs before every delivery/retry, irrespective of FCM/APNs/client version. */
export async function prepareNearbyRequestRinging(
  manager: EntityManager,
  notification: Pick<Notification, 'id' | 'userId' | 'data'>,
): Promise<boolean> {
  if (!isNearbyRingingRequest(notification.data)) return true;
  const driverId = notification.userId;
  let requestId: unknown =
    notification.data?.tripRequestId ?? notification.data?.requestId;
  // Old dispatch payloads identify the invitation only. Resolve its order without
  // changing the payload or trusting a client-provided driver's identity.
  if (
    !requestId &&
    driverId &&
    notification.data?.type === 'driver_dispatch_offer' &&
    notification.data?.offerId
  ) {
    const [offer]: { requestId: string }[] = await manager.query(
      `SELECT "requestId" FROM trip_request_dispatch_offers
      WHERE id = $1 AND "driverId" = $2`,
      [notification.data.offerId, driverId],
    );
    requestId = offer?.requestId;
  }
  if (
    !driverId ||
    typeof requestId !== 'string' ||
    !notification.id ||
    notification.data?.passengerId === driverId
  )
    return false;
  return manager.transaction(async (tx) => {
    if (!(await tx.query(`SELECT 1 WHERE ${requestDriverVisibilitySql('$1::uuid', '$2::uuid')}`, [requestId, driverId])).length) return false;
    const state = await lockState(tx, driverId);
    await reconcile(tx, state);
    const now = new Date(state.now).getTime();
    let deadline = now + 60_000;
    for (const value of [
      notification.data?.expiresAt,
      notification.data?.alertExpiresAt,
    ]) {
      if (value === undefined) continue;
      const parsed = Date.parse(String(value));
      if (!Number.isFinite(parsed)) return false;
      deadline = Math.min(deadline, parsed);
    }
    // Expired quiet backups do not create an invitation. The existing delivery policy
    // still decides whether the informational notification is useful.
    if (deadline <= now) return true;
    // An explicit passenger selection is a new invitation, not a retry of an old
    // expired ring. Fence it to the current offer ID; never revive an old push.
    if (notification.data?.mapDriverPriority === true) await tx.query(`UPDATE nearby_driver_ring_events e
      SET "notificationId"=$3,"responseDeadline"=$4,"receivedAt"=NULL,"processedAt"=NULL,"declinedAt"=NULL,outcome=NULL
      WHERE e."driverId"=$1 AND e."requestId"=$2 AND e."notificationId"<>$3 AND EXISTS
        (SELECT 1 FROM trip_requests r JOIN trip_request_dispatch_offers o ON o."requestId"=r.id
         WHERE r.id=$2 AND r."targetDriverId"=$1 AND r."targetDriverPriorityUntil">clock_timestamp()
           AND o.id=$5 AND o."driverId"=$1 AND o.status='pending' AND o.phase='driver' AND o."expiresAt">clock_timestamp())`,
      [driverId, requestId, notification.id, new Date(deadline), notification.data.offerId]);
    await tx.query(
      `INSERT INTO nearby_driver_ring_events
      ("driverId", "requestId", "notificationId", "responseDeadline") VALUES ($1,$2,$3,$4)
      ON CONFLICT ("driverId", "requestId") DO UPDATE SET "responseDeadline" = EXCLUDED."responseDeadline"
      WHERE nearby_driver_ring_events."notificationId" = EXCLUDED."notificationId"
        AND nearby_driver_ring_events."processedAt" IS NULL AND nearby_driver_ring_events."declinedAt" IS NULL
        AND nearby_driver_ring_events."receivedAt" IS NULL
        AND EXISTS (SELECT 1 FROM notifications n WHERE n.id = EXCLUDED."notificationId" AND n.status <> 'sent')`,
      [driverId, requestId, notification.id, new Date(deadline)],
    );
    const [event]: {
      notificationId: string;
      processedAt: Date | null;
      declinedAt: Date | null;
    }[] = await tx.query(
      `SELECT "notificationId", "processedAt", "declinedAt"
      FROM nearby_driver_ring_events WHERE "driverId" = $1 AND "requestId" = $2`,
      [driverId, requestId],
    );
    return (
      event.notificationId === notification.id &&
      !event.processedAt &&
      !event.declinedAt
    );
  });
}

/** Authenticated recipient acknowledgement, idempotent and bounded by the original deadline. */
export async function acknowledgeNearbyRequest(
  manager: EntityManager,
  driverId: string,
  notificationId: string,
): Promise<{ received: boolean }> {
  const rows:
    { notificationId: string }[] | [{ notificationId: string }[], number] =
    await manager.query(
      `UPDATE nearby_driver_ring_events e
    SET "receivedAt" = COALESCE(e."receivedAt", clock_timestamp())
    WHERE e."driverId" = $1 AND e."notificationId" = $2 AND e."processedAt" IS NULL
      AND e."responseDeadline" > clock_timestamp()
      AND EXISTS (SELECT 1 FROM trip_requests r WHERE r.id = e."requestId"
        AND r."passengerId" <> $1 AND r.status IN ('pending','offers_received')
        AND r."selectedDriverId" IS NULL AND r."tripId" IS NULL AND r."departureDateMax" > clock_timestamp())
    RETURNING e."notificationId"`,
      [driverId, notificationId],
    );
  // TypeORM PostgreSQL UPDATE ... RETURNING returns [rows, affected].
  return {
    received: Array.isArray(rows?.[0]) ? rows[0].length > 0 : rows.length > 0,
  };
}

/** A refusal only belongs to this recipient; it never cancels the passenger's order. */
export async function declineNearbyRequest(
  manager: EntityManager,
  driverId: string,
  requestId: string,
) {
  return declineRequestForDriver(manager, driverId, requestId);
}

/** Bounded event cleanup for sleeping apps. Historical export name; no cooldown remains. */
export async function reconcileNearbyRequestCooldowns(
  manager: EntityManager,
): Promise<void> {
  const drivers: { driverId: string }[] =
    await manager.query(`SELECT DISTINCT e."driverId"
    FROM nearby_driver_ring_events e
    WHERE e."processedAt" IS NULL AND e."responseDeadline" <= now()
    ORDER BY e."driverId" LIMIT 100`);
  for (const { driverId } of drivers) {
    await manager.transaction(async (tx) =>
      reconcile(tx, await lockState(tx, driverId)),
    );
  }
}
