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

export async function finishRideProgress(
  db: Sql,
  job: RideProgressJob,
  failed: boolean,
) {
  // Atomic conditional deletion; a GPS sample committed while work ran remains queued.
  if (!failed)
    await db.query(
      `DELETE FROM ride_progress_jobs WHERE "tripId"=$1 AND "leaseToken"=$2 AND version=$3`,
      [job.tripId, job.leaseToken, job.version],
    );
  await db.query(
    `UPDATE ride_progress_jobs SET "leaseToken"=NULL,"leaseUntil"=NULL,
    "availableAt"=clock_timestamp()+($3::int * interval '1 millisecond')
    WHERE "tripId"=$1 AND "leaseToken"=$2`,
    [job.tripId, job.leaseToken, failed ? 5000 : 1000],
  );
}
