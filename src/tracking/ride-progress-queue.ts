import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';

type Sql = Pick<DataSource, 'query'>;
export type RideProgressJob = {
  tripId: string;
  version: string;
  leaseToken: string;
};

/** Acknowledge GPS only after this write. Updates coalesce without erasing an active lease. */
export async function enqueueRideProgress(db: Sql, tripId: string) {
  await db.query(
    `INSERT INTO ride_progress_jobs("tripId") VALUES ($1)
    ON CONFLICT("tripId") DO UPDATE SET version=ride_progress_jobs.version+1`,
    [tripId],
  );
}

export async function claimRideProgress(
  db: Sql,
  limit: number,
): Promise<RideProgressJob[]> {
  return db.query(
    `WITH due AS (SELECT "tripId" FROM ride_progress_jobs
    WHERE "availableAt" <= clock_timestamp() AND ("leaseUntil" IS NULL OR "leaseUntil" < clock_timestamp())
    ORDER BY "availableAt","tripId" LIMIT $1 FOR UPDATE SKIP LOCKED), claimed AS (
    UPDATE ride_progress_jobs j SET "leaseToken"=$2,"leaseUntil"=clock_timestamp()+interval '90 seconds'
    FROM due WHERE j."tripId"=due."tripId" RETURNING j."tripId",j.version,j."leaseToken")
    SELECT * FROM claimed`,
    [Math.min(4, Math.max(1, limit)), randomUUID()],
  );
}

// Lock the current version before deciding to delete or release. Both finish
// paths preserve a concurrent GPS and cannot release a replacement's lease.
const FINISH_RIDE_PROGRESS = `WITH owned AS MATERIALIZED (
      SELECT "tripId",version FROM ride_progress_jobs
      WHERE "tripId"=$1 AND "leaseToken"=$2 FOR UPDATE
    ), finished AS (
      DELETE FROM ride_progress_jobs j USING owned o
      WHERE j."tripId"=o."tripId" AND NOT $4::boolean AND o.version=$3::bigint
      RETURNING j."tripId"
    ), released AS (
      UPDATE ride_progress_jobs j SET "leaseToken"=NULL,"leaseUntil"=NULL,
        "availableAt"=clock_timestamp()+($5::int * interval '1 millisecond')
      FROM owned o WHERE j."tripId"=o."tripId" AND ($4::boolean OR o.version<>$3::bigint)
      RETURNING j."tripId"
    )`;

export async function finishRideProgress(
  db: Sql,
  job: RideProgressJob,
  failed: boolean,
  retryDelayMs: 1000 | 5000 = 5000,
) {
  await db.query(
    `${FINISH_RIDE_PROGRESS} SELECT "tripId" FROM finished UNION ALL SELECT "tripId" FROM released`,
    [job.tripId, job.leaseToken, job.version, failed, failed ? retryDelayMs : 1000],
  );
}

/** Transfer exactly one occupied worker slot, atomically with acknowledgement.
 * No in-memory prefetch: the caller must immediately process the returned job,
 * or release it if shutdown started while this statement was in flight. */
export async function finishAndClaimRideProgress(
  db: Sql,
  job: RideProgressJob,
  failed: boolean,
  retryDelayMs: 1000 | 5000 = 5000,
): Promise<RideProgressJob | undefined> {
  const rows: RideProgressJob[] = await db.query(
    `${FINISH_RIDE_PROGRESS}, settled AS MATERIALIZED (
      SELECT "tripId" FROM finished UNION ALL SELECT "tripId" FROM released
    ), due AS MATERIALIZED (
      SELECT j."tripId" FROM ride_progress_jobs j
      WHERE j."tripId"<>$1 AND EXISTS (SELECT 1 FROM settled)
        AND j."availableAt"<=clock_timestamp()
        AND (j."leaseUntil" IS NULL OR j."leaseUntil"<clock_timestamp())
      ORDER BY j."availableAt",j."tripId" LIMIT 1 FOR UPDATE OF j SKIP LOCKED
    ), claimed AS (
      UPDATE ride_progress_jobs j SET "leaseToken"=$6,"leaseUntil"=clock_timestamp()+interval '90 seconds'
      FROM due WHERE j."tripId"=due."tripId" RETURNING j."tripId",j.version,j."leaseToken"
    ) SELECT * FROM claimed`,
    [job.tripId, job.leaseToken, job.version, failed, failed ? retryDelayMs : 1000, randomUUID()],
  );
  return rows[0];
}
