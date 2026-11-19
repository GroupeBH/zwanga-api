import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';

/** Cross-replica scheduling without holding a pooled SQL connection during work. */
export async function runExclusiveMaintenanceJob<T>(
  db: Pick<DataSource, 'query'>,
  name: string,
  intervalMs: number,
  work: (assertLease: () => void) => Promise<T>,
): Promise<T | null> {
  const token = randomUUID();
  const acquired = await db.query(
    `INSERT INTO maintenance_job_leases(name,token,"leaseUntil","nextRunAt")
    VALUES ($1,$2,clock_timestamp()+interval '90 seconds',clock_timestamp())
    ON CONFLICT(name) DO UPDATE SET token=EXCLUDED.token,"leaseUntil"=EXCLUDED."leaseUntil"
    WHERE maintenance_job_leases."leaseUntil" < clock_timestamp()
      AND maintenance_job_leases."nextRunAt" <= clock_timestamp() RETURNING name`,
    [name, token],
  );
  if (!acquired.length) return null;
  let failed = true;
  let lostLease = false;
  let renewal: Promise<void> | undefined;
  const assertLease = () => {
    if (lostLease) throw new Error(`Maintenance job lease lost: ${name}`);
  };
  const heartbeat = setInterval(() => {
    if (renewal) return;
    renewal = db
      .query(
        `WITH renewed AS (UPDATE maintenance_job_leases SET "leaseUntil"=clock_timestamp()+interval '90 seconds'
      WHERE name=$1 AND token=$2 RETURNING name) SELECT name FROM renewed`,
        [name, token],
      )
      .then((rows) => {
        if (!rows.length) lostLease = true;
      })
      .catch(() => {
        lostLease = true;
      })
      .finally(() => {
        renewal = undefined;
      });
  }, 20_000);
  heartbeat.unref();
  try {
    const result = await work(assertLease);
    await renewal;
    assertLease();
    failed = false;
    return result;
  } finally {
    clearInterval(heartbeat);
    await renewal;
    // Align successful runs to the next schedule boundary. Completion+5min would
    // skip the following 5min cron tick and accidentally halve the audit cadence.
    await db.query(
      `UPDATE maintenance_job_leases SET "leaseUntil"=clock_timestamp(),
      "nextRunAt"=CASE WHEN $4::boolean THEN clock_timestamp()+interval '30 seconds'
        ELSE to_timestamp((floor(extract(epoch FROM clock_timestamp())*1000/$3::int)+1)*$3::int/1000.0) END
      WHERE name=$1 AND token=$2`,
      [name, token, intervalMs, failed],
    );
  }
}
