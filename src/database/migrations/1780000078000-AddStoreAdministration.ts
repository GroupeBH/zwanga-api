import type { MigrationInterface, QueryRunner } from 'typeorm';
export class AddStoreAdministration1780000078000 implements MigrationInterface {
  async up(r: QueryRunner) {
    await r.query(`CREATE TABLE store_integrations (
      platform text PRIMARY KEY CHECK (platform IN ('google','apple')), enabled boolean NOT NULL DEFAULT true,
      schedule jsonb NOT NULL DEFAULT '{}', "checkedAt" timestamptz, "errorCode" text, capabilities jsonb, "updatedAt" timestamptz NOT NULL DEFAULT now());
      INSERT INTO store_integrations(platform) VALUES ('google'),('apple');
      CREATE TABLE store_access_grants ("userId" uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        profile text NOT NULL, permissions jsonb NOT NULL, "updatedAt" timestamptz NOT NULL DEFAULT now());
      CREATE TABLE store_review_workflows (
        "recordId" uuid PRIMARY KEY REFERENCES store_records(id) ON DELETE CASCADE,
        status text NOT NULL DEFAULT 'new' CHECK (status IN ('new','in_progress','draft','pending_approval','approved','responded','closed')),
        "assigneeId" uuid REFERENCES users(id) ON DELETE SET NULL, draft text, revision integer NOT NULL DEFAULT 0,
        "preparedBy" uuid REFERENCES users(id) ON DELETE SET NULL, "approvedBy" uuid REFERENCES users(id) ON DELETE SET NULL,
        "approvedRevision" integer, "publishedJobId" uuid REFERENCES store_sync_jobs(id) ON DELETE SET NULL,
        "updatedAt" timestamptz NOT NULL DEFAULT now());
      CREATE INDEX "IDX_store_workflow_assignee" ON store_review_workflows("assigneeId");
      CREATE INDEX "IDX_store_workflow_status" ON store_review_workflows(status,"updatedAt");
      CREATE INDEX "IDX_store_workflow_job" ON store_review_workflows("publishedJobId");
      CREATE INDEX "IDX_store_workflow_author" ON store_review_workflows("preparedBy");
      CREATE INDEX "IDX_store_workflow_approver" ON store_review_workflows("approvedBy");
      CREATE TABLE store_audit_logs (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), "actorId" uuid REFERENCES users(id) ON DELETE SET NULL,
        action text NOT NULL, "subjectId" text NOT NULL, details jsonb NOT NULL DEFAULT '{}', "createdAt" timestamptz NOT NULL DEFAULT now());
      CREATE INDEX "IDX_store_audit_page" ON store_audit_logs("createdAt",id);
      CREATE INDEX "IDX_store_audit_actor" ON store_audit_logs("actorId");
      CREATE INDEX "IDX_store_audit_subject" ON store_audit_logs("subjectId","createdAt");
      CREATE TABLE store_release_incidents (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), "recordId" uuid NOT NULL REFERENCES store_records(id) ON DELETE RESTRICT,
        category text NOT NULL, note text NOT NULL, "taskReference" text, "ownerId" uuid REFERENCES users(id) ON DELETE SET NULL,
        "resolvedAt" timestamptz, "createdAt" timestamptz NOT NULL DEFAULT now());
      CREATE INDEX "IDX_store_incident_record" ON store_release_incidents("recordId","createdAt");
      CREATE INDEX "IDX_store_incident_owner" ON store_release_incidents("ownerId");
      CREATE TABLE store_alert_rules (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), name text NOT NULL, platform text CHECK (platform IN ('google','apple')),
        type text NOT NULL, metric text, threshold double precision, severity text NOT NULL DEFAULT 'warning',
        enabled boolean NOT NULL DEFAULT true, recipients jsonb NOT NULL DEFAULT '[]', email boolean NOT NULL DEFAULT false, "updatedAt" timestamptz NOT NULL DEFAULT now());
      CREATE TABLE store_alert_events (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), "eventKey" text NOT NULL,
        "ruleId" uuid REFERENCES store_alert_rules(id) ON DELETE SET NULL, platform text NOT NULL, code text NOT NULL,
        severity text NOT NULL, message text NOT NULL, recipients jsonb NOT NULL DEFAULT '[]', "emailState" text NOT NULL DEFAULT 'not_requested', "emailClaimedAt" timestamptz,
        "acknowledgedAt" timestamptz, "acknowledgedBy" uuid REFERENCES users(id) ON DELETE SET NULL, "createdAt" timestamptz NOT NULL DEFAULT now());
      CREATE UNIQUE INDEX "UQ_store_alert_event" ON store_alert_events("eventKey");
      CREATE INDEX "IDX_store_alert_page" ON store_alert_events("createdAt",id);
      CREATE INDEX "IDX_store_alert_rule" ON store_alert_events("ruleId");
      CREATE INDEX "IDX_store_alert_acknowledger" ON store_alert_events("acknowledgedBy");
      CREATE INDEX "IDX_store_alert_delivery" ON store_alert_events("emailState","createdAt") WHERE "emailState" IN ('pending','sending');
      ALTER TABLE store_sync_jobs DROP CONSTRAINT store_sync_jobs_task_check;
      ALTER TABLE store_sync_jobs ADD CONSTRAINT store_sync_jobs_task_check CHECK (task IN ('catalog','reviews','reports','vitals','reply','analytics_request','connection'));`);
  }
  async down(r: QueryRunner) {
    await r.query(`UPDATE store_sync_jobs SET task='catalog', lane='legacy_connection' WHERE task='connection';
      ALTER TABLE store_sync_jobs DROP CONSTRAINT store_sync_jobs_task_check;
      ALTER TABLE store_sync_jobs ADD CONSTRAINT store_sync_jobs_task_check CHECK (task IN ('catalog','reviews','reports','vitals','reply','analytics_request'));
      DROP TABLE store_alert_events; DROP TABLE store_alert_rules; DROP TABLE store_release_incidents;
      DROP TABLE store_audit_logs; DROP TABLE store_review_workflows; DROP TABLE store_access_grants; DROP TABLE store_integrations;`);
  }
}
