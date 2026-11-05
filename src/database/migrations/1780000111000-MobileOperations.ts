import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Additive only: legacy installations/releases and notification outbox remain authoritative. */
export class MobileOperations1780000111000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query(
      `CREATE TABLE mobile_operation_ticks (key text PRIMARY KEY, "nextAt" timestamptz NOT NULL)`,
    );
    await q.query(`CREATE INDEX notifications_mobile_campaign_idx ON notifications("createdAt",id)
      WHERE data->>'type'='mobile_campaign' AND "isActive" AND status IN ('pending','failed')`);
    await q.query(`ALTER TABLE app_update_installations
      ADD COLUMN "userId" uuid REFERENCES users(id) ON DELETE SET NULL,
      ADD COLUMN "linkedAt" timestamptz,
      ADD COLUMN "firstLinkedAt" timestamptz,
      ADD COLUMN "linkSequence" bigint NOT NULL DEFAULT 0,
      ADD COLUMN "mobileMetadata" jsonb NOT NULL DEFAULT '{}'::jsonb`);
    await q.query(
      `CREATE INDEX mobile_installations_user_idx ON app_update_installations("userId") WHERE "userId" IS NOT NULL`,
    );
    await q.query(
      `CREATE INDEX mobile_installations_activity_idx ON app_update_installations("updatedAt",id)`,
    );
    await q.query(`CREATE TABLE mobile_installation_days (
      "installationId" uuid NOT NULL REFERENCES app_update_installations(id) ON DELETE CASCADE,
      day date NOT NULL, platform varchar(7) NOT NULL, version varchar(32) NOT NULL,
      PRIMARY KEY ("installationId", day))`);
    await q.query(
      `CREATE INDEX mobile_installation_days_date_idx ON mobile_installation_days(day,platform,version)`,
    );
    await q.query(`CREATE TABLE mobile_update_policies (
      id uuid PRIMARY KEY, platform varchar(7) NOT NULL CHECK (platform IN ('android','ios')),
      environment varchar(20) NOT NULL, "releaseId" bigint NOT NULL REFERENCES app_store_releases(id),
      mode varchar(16) NOT NULL CHECK (mode IN ('NONE','OPTIONAL','RECOMMENDED','REQUIRED')),
      "minimumBuild" varchar(32) NOT NULL, "minimumVersion" varchar(32),
      message varchar(500) NOT NULL, "storeUrl" varchar(500) NOT NULL,
      audience varchar(16) NOT NULL CHECK (audience IN ('all','anonymous','linked')),
      "blockedFeatures" jsonb NOT NULL DEFAULT '[]',
      "effectiveAt" timestamptz NOT NULL, "expiresAt" timestamptz,
      "availabilityConfirmed" boolean NOT NULL DEFAULT false,
      "availabilityEvidence" varchar(500) NOT NULL,
      active boolean NOT NULL DEFAULT false, revision integer NOT NULL DEFAULT 1, "requestHash" varchar(64) NOT NULL,
      "createdBy" uuid REFERENCES users(id) ON DELETE SET NULL,
      "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now(),
      CHECK ("expiresAt" IS NULL OR "expiresAt">"effectiveAt"))`);
    await q.query(
      `CREATE INDEX mobile_policy_scope_idx ON mobile_update_policies(platform,environment,"effectiveAt" DESC) WHERE active`,
    );
    await q.query(
      `CREATE INDEX mobile_policy_release_idx ON mobile_update_policies("releaseId")`,
    );
    await q.query(
      `CREATE INDEX mobile_policy_author_idx ON mobile_update_policies("createdBy")`,
    );
    await q.query(`CREATE TABLE mobile_campaigns (
      id uuid PRIMARY KEY, title varchar(90) NOT NULL, body varchar(300) NOT NULL,
      kind varchar(24) NOT NULL, category varchar(20) NOT NULL CHECK (category IN ('operational','updates','marketing')),
      audience jsonb NOT NULL, state varchar(20) NOT NULL DEFAULT 'draft'
        CHECK (state IN ('draft','approved','scheduled','running','completed','cancelled')),
      revision integer NOT NULL DEFAULT 1, "requestHash" varchar(64) NOT NULL, "createdBy" uuid REFERENCES users(id) ON DELETE SET NULL,
      "approvedBy" uuid REFERENCES users(id) ON DELETE SET NULL, "launchedBy" uuid REFERENCES users(id) ON DELETE SET NULL,
      "scheduledAt" timestamptz, "startedAt" timestamptz, "expiresAt" timestamptz NOT NULL,
      "cursorId" uuid, "nextBatchAt" timestamptz NOT NULL DEFAULT now(),
      "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now())`);
    await q.query(
      `CREATE INDEX mobile_campaign_due_idx ON mobile_campaigns("nextBatchAt","scheduledAt") WHERE state IN ('scheduled','running')`,
    );
    for (const field of ['createdBy', 'approvedBy', 'launchedBy'])
      await q.query(
        `CREATE INDEX "mobile_campaign_${field}_idx" ON mobile_campaigns("${field}")`,
      );
    await q.query(`CREATE TABLE mobile_campaign_deliveries (
      "campaignId" uuid NOT NULL REFERENCES mobile_campaigns(id) ON DELETE CASCADE,
      "installationId" uuid NOT NULL REFERENCES app_update_installations(id) ON DELETE CASCADE,
      "notificationId" uuid NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
      "openedAt" timestamptz, "createdAt" timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY ("campaignId","installationId"), UNIQUE ("notificationId"))`);
    await q.query(
      `CREATE INDEX mobile_delivery_installation_idx ON mobile_campaign_deliveries("installationId","createdAt" DESC)`,
    );
    // Reuse Store Management alerts and audit, rather than introduce a second admin inbox.
    await q.query(`ALTER TABLE store_alert_rules
      ADD COLUMN "windowMinutes" integer NOT NULL DEFAULT 60 CHECK ("windowMinutes" BETWEEN 5 AND 10080),
      ADD COLUMN "confirmationMinutes" integer NOT NULL DEFAULT 5 CHECK ("confirmationMinutes" BETWEEN 0 AND 1440)`);
    await q.query(`CREATE TABLE mobile_alert_state (
      "ruleId" uuid PRIMARY KEY REFERENCES store_alert_rules(id) ON DELETE CASCADE,
      "breachedAt" timestamptz, "lastEventAt" timestamptz, "evaluatedAt" timestamptz NOT NULL DEFAULT now())`);
    await q.query(`ALTER TABLE store_alert_events ADD COLUMN "resolvedAt" timestamptz,
      ADD COLUMN "resolvedBy" uuid REFERENCES users(id) ON DELETE SET NULL,
      ADD COLUMN "resolution" varchar(500)`);
    await q.query(
      `CREATE INDEX store_alert_resolved_by_idx ON store_alert_events("resolvedBy")`,
    );
  }
  async down(q: QueryRunner): Promise<void> {
    await q.query('DROP INDEX notifications_mobile_campaign_idx');
    await q.query(
      `ALTER TABLE store_alert_events DROP COLUMN "resolution", DROP COLUMN "resolvedBy", DROP COLUMN "resolvedAt"`,
    );
    await q.query(`DROP TABLE mobile_alert_state`);
    await q.query(
      `ALTER TABLE store_alert_rules DROP COLUMN "confirmationMinutes", DROP COLUMN "windowMinutes"`,
    );
    await q.query(
      `DROP TABLE mobile_campaign_deliveries, mobile_campaigns, mobile_update_policies, mobile_installation_days, mobile_operation_ticks`,
    );
    await q.query(`DROP INDEX mobile_installations_activity_idx`);
    await q.query(`ALTER TABLE app_update_installations DROP COLUMN "mobileMetadata", DROP COLUMN "linkSequence",
      DROP COLUMN "firstLinkedAt", DROP COLUMN "linkedAt", DROP COLUMN "userId"`);
  }
}
