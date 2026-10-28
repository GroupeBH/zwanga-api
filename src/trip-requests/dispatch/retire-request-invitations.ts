import type { EntityManager } from 'typeorm';

// Both updates use IDX_notifications_active_request_type. Keep the request
// expression in text form: older JSON payloads need not contain valid UUIDs.
export const RETIRE_COUNTEROFFER_NOTIFICATIONS_SQL = `UPDATE notifications n SET "isActive"=false
  WHERE n."isActive"=true AND n.data->>'tripRequestId'=$1::text
    AND n.data->>'type'='driver_offer' AND n.data->>'offerId'=ANY($2::text[])`;

export const RETIRE_REQUEST_NOTIFICATIONS_SQL = `UPDATE notifications n SET "isActive"=false
  WHERE n."isActive"=true AND n.data->>'tripRequestId'=$1::text
    AND n.data->>'type' IN ('trip_request_nearby','driver_dispatch_offer','trip_request','new_trip_request')
    AND ($2 OR NOT EXISTS (SELECT 1 FROM trip_request_dispatch_offers o
      WHERE o."requestId"=$1::uuid AND o."driverId"=n."userId"
        AND o.status='pending' AND o."expiresAt">clock_timestamp()))`;

/** Caller holds the request row lock. Retirement and notification invalidation
 * must commit together: moving cleanup after commit could send an obsolete push.
 * Work is scoped to this request, never the whole notification history. */
export async function retireRequestInvitations(manager: EntityManager, id: string, terminal: boolean): Promise<boolean> {
  await manager.query(`UPDATE driver_offers d SET status='cancelled', "updatedAt"=clock_timestamp()
    WHERE d."tripRequestId"=$1 AND d.status='pending' AND ($2 OR EXISTS (
      SELECT 1 FROM trip_request_dispatch_offers o WHERE o."requestId"=$1 AND o."driverId"=d."driverId"
        AND o.status='pending' AND o.phase='passenger' AND o."expiresAt"<=clock_timestamp()))`, [id, terminal]);

  // Include previously rejected/cancelled offers for crash/legacy recovery, not
  // just UPDATE ... RETURNING. Usually there are none: skip notification SQL.
  const closed: { id: string }[] = await manager.query(`SELECT id FROM driver_offers
    WHERE "tripRequestId"=$1 AND status IN ('cancelled','rejected')`, [id]);
  if (closed.length) await manager.query(RETIRE_COUNTEROFFER_NOTIFICATIONS_SQL, [id, closed.map(offer => offer.id)]);

  const retired = await manager.query(`UPDATE trip_request_dispatch_offers SET status=$2
    WHERE "requestId"=$1 AND status='pending' AND ($3 OR "expiresAt"<=clock_timestamp()) RETURNING id`,
    [id, terminal ? 'cancelled' : 'expired', terminal]);
  await manager.query(RETIRE_REQUEST_NOTIFICATIONS_SQL, [id, terminal]);
  return retired[1] > 0;
}
