import { MigrationInterface, QueryRunner } from 'typeorm';

export class PerformanceWorkQueues1780000135000 implements MigrationInterface {
  async up(q: QueryRunner) {
    await q.query(`CREATE TABLE ride_progress_jobs (
      "tripId" uuid PRIMARY KEY REFERENCES trips(id) ON DELETE CASCADE,
      version bigint NOT NULL DEFAULT 1,
      "availableAt" timestamptz NOT NULL DEFAULT clock_timestamp(),
      "leaseUntil" timestamptz, "leaseToken" uuid,
      "createdAt" timestamptz NOT NULL DEFAULT clock_timestamp()
    );
    CREATE INDEX ride_progress_jobs_due ON ride_progress_jobs("availableAt");
    CREATE TABLE maintenance_job_leases (
      name text PRIMARY KEY, token uuid NOT NULL,
      "leaseUntil" timestamptz NOT NULL, "nextRunAt" timestamptz NOT NULL
    );`);
  }
  async down(q: QueryRunner) {
    // Do not discard pending automatic pickup/dropoff work during rollback.
    await q.query(`LOCK TABLE ride_progress_jobs, maintenance_job_leases IN ACCESS EXCLUSIVE MODE;
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM ride_progress_jobs) THEN
        RAISE EXCEPTION 'Drain ride progress jobs before rollback';
      END IF;
      IF EXISTS (SELECT 1 FROM maintenance_job_leases WHERE "leaseUntil" > clock_timestamp()) THEN
        RAISE EXCEPTION 'Stop maintenance workers before rollback';
      END IF;
    END $$; DROP TABLE ride_progress_jobs; DROP TABLE maintenance_job_leases;`);
  }
}
