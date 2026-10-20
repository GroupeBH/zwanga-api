import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddStoreManagement1780000077000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`CREATE TABLE store_records (
      id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), platform text NOT NULL CHECK (platform IN ('google','apple')),
      "appId" text NOT NULL, kind text NOT NULL, "externalId" text NOT NULL,
      content jsonb NOT NULL, "isCurrent" boolean NOT NULL DEFAULT true, "syncedAt" timestamptz NOT NULL DEFAULT now());
      CREATE UNIQUE INDEX "UQ_store_record" ON store_records(platform,"appId",kind,"externalId");
      CREATE INDEX "IDX_store_records_page" ON store_records(platform,"appId",kind,"syncedAt",id);
      CREATE TABLE store_metrics (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), platform text NOT NULL CHECK (platform IN ('google','apple')),
        "appId" text NOT NULL, dataset text NOT NULL, date date NOT NULL,
        metric text NOT NULL, dimension text NOT NULL, value numeric(22,6) NOT NULL CHECK (value >= 0 AND value <> 'NaN'::numeric),
        "importedAt" timestamptz NOT NULL DEFAULT now());
      CREATE UNIQUE INDEX "UQ_store_metric" ON store_metrics(platform,"appId",dataset,date,metric,dimension);
      CREATE INDEX "IDX_store_metrics_period" ON store_metrics(platform,"appId",date,metric);
      CREATE TABLE store_sync_jobs (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), "requestKey" text NOT NULL,
        platform text NOT NULL CHECK (platform IN ('google','apple')), "appId" text NOT NULL,
        task text NOT NULL CHECK (task IN ('catalog','reviews','reports','vitals','reply','analytics_request')),
        lane text NOT NULL, input jsonb NOT NULL, "actorId" uuid REFERENCES users(id) ON DELETE SET NULL,
        state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','running','succeeded','failed','unavailable','unknown')),
        attempts integer NOT NULL DEFAULT 0, processed integer NOT NULL DEFAULT 0,
        "errorCode" text, "leaseToken" uuid, "leaseUntil" timestamptz,
        "nextAttemptAt" timestamptz NOT NULL DEFAULT now(), "createdAt" timestamptz NOT NULL DEFAULT now(), "completedAt" timestamptz);
      CREATE UNIQUE INDEX "UQ_store_job_request" ON store_sync_jobs("requestKey");
      CREATE UNIQUE INDEX "UQ_store_job_active" ON store_sync_jobs(platform,"appId",lane) WHERE state IN ('pending','running');
      CREATE INDEX "IDX_store_jobs_due" ON store_sync_jobs(state,"nextAttemptAt");
      CREATE INDEX "IDX_store_jobs_history" ON store_sync_jobs(platform,"appId","createdAt",id);
      CREATE INDEX "IDX_store_jobs_actor" ON store_sync_jobs("actorId") WHERE "actorId" IS NOT NULL;`);
  }
  async down(runner: QueryRunner): Promise<void> {
    // Only this module's imported data/history; no business table is altered.
    await runner.query(
      'DROP TABLE store_sync_jobs; DROP TABLE store_metrics; DROP TABLE store_records;',
    );
  }
}
