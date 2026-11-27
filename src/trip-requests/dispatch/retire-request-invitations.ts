import type { EntityManager } from 'typeorm';

// Both updates use IDX_notifications_active_request_type. Keep the request
// expression in text form: older JSON payloads need not contain valid UUIDs.
const retireCounterofferNotifications = (offerPredicate: string) => `UPDATE notifications n SET "isActive"=false
  WHERE n."isActive"=true AND n.data->>'tripRequestId'=$1::text
    AND n.data->>'type'='driver_offer' AND n.data->>'offerId' ${offerPredicate}`;
export const RETIRE_COUNTEROFFER_NOTIFICATIONS_SQL = retireCounterofferNotifications('=ANY($2::text[])');

export const RETIRE_REQUEST_NOTIFICATIONS_SQL = `UPDATE notifications n SET "isActive"=false
  WHERE n."isActive"=true AND n.data->>'tripRequestId'=$1::text
    AND n.data->>'type' IN ('trip_request_nearby','driver_dispatch_offer','trip_request','new_trip_request')
    AND ($2 OR NOT EXISTS (SELECT 1 FROM trip_request_dispatch_offers o
      WHERE o."requestId"=$1::uuid AND o."driverId"=n."userId"
        AND o.status='pending' AND o."expiresAt">clock_timestamp()))`;

// The CTEs share a snapshot: include the UPDATE's RETURNING rows explicitly in
// closed, otherwise newly cancelled counteroffer messages would remain active.
// The two notification updates have disjoint types and cannot modify one row twice.
export const RETIRE_REQUEST_INVITATIONS_SQL = `WITH cancelled AS (
  UPDATE driver_offers d SET status='cancelled', "updatedAt"=clock_timestamp()
    WHERE d."tripRequestId"=$1 AND d.status='pending' AND ($2 OR EXISTS (
      SELECT 1 FROM trip_request_dispatch_offers o WHERE o."requestId"=$1 AND o."driverId"=d."driverId"
        AND o.status='pending' AND o.phase='passenger' AND o."expiresAt"<=clock_timestamp()))
    RETURNING id
), closed AS MATERIALIZED (
  SELECT id FROM driver_offers WHERE "tripRequestId"=$1 AND status IN ('cancelled','rejected')
  UNION SELECT id FROM cancelled
), counteroffer_notices AS (
  ${retireCounterofferNotifications('IN (SELECT id::text FROM closed)')} RETURNING n.id
), retired AS (
  UPDATE trip_request_dispatch_offers SET status=CASE WHEN $2 THEN 'cancelled' ELSE 'expired' END
    WHERE "requestId"=$1 AND status='pending' AND ($2 OR "expiresAt"<=clock_timestamp()) RETURNING id, "driverId"
), request_notices AS (
  ${RETIRE_REQUEST_NOTIFICATIONS_SQL} RETURNING n.id
) SELECT id, "driverId" FROM retired`;

/** Caller holds the request row lock. One round trip inside that transaction;
 * invitations and their notification invalidation still commit together. */
export async function retireRequestInvitations(manager: EntityManager, id: string, terminal: boolean, releasedDrivers?: string[]): Promise<boolean> {
  const retired: { id: string; driverId: string }[] = await manager.query(RETIRE_REQUEST_INVITATIONS_SQL, [id, terminal]);
  if (releasedDrivers) for (const row of retired) releasedDrivers.push(row.driverId);
  return retired.length > 0;
}
