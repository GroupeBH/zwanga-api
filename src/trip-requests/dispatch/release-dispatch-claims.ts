import type { DataSource } from 'typeorm';

/** A fallback-scan lease is not the business/request lock. Release its completed
 * batch in one round trip, without blocking GPS/receipts behind a busy request.
 * A busy row retains its short lease until the existing ten-second expiry.
 * Never clear a lease reclaimed by a different worker. */
export async function releaseDispatchClaims(db: Pick<DataSource, 'query'>, ids: string[], leaseId: string): Promise<void> {
  if (!ids.length) return;
  await db.query(`UPDATE trip_requests SET "dispatchLeaseId"=NULL, "dispatchClaimedUntil"=NULL
    WHERE id IN (SELECT id FROM trip_requests WHERE id=ANY($1::uuid[]) AND "dispatchLeaseId"=$2
      ORDER BY id FOR UPDATE SKIP LOCKED) AND "dispatchLeaseId"=$2`, [[...new Set(ids)], leaseId]);
}
