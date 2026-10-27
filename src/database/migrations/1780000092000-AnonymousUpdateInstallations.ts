import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AnonymousUpdateInstallations1780000092000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`CREATE TABLE app_update_installations (
      id uuid PRIMARY KEY, "secretHash" varchar(64) NOT NULL,
      platform varchar(7) NOT NULL CHECK (platform IN ('ios','android')),
      version varchar(32) NOT NULL, build varchar(32) NOT NULL,
      "pushToken" varchar(2048), "tokenHash" varchar(64) UNIQUE,
      enabled boolean NOT NULL DEFAULT false, sequence bigint NOT NULL DEFAULT 0,
      "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now(),
      CHECK (NOT enabled OR ("pushToken" IS NOT NULL AND "tokenHash" IS NOT NULL))
    )`);
    await runner.query(
      `CREATE INDEX app_update_installations_audience_idx ON app_update_installations(platform, "updatedAt", id) WHERE enabled = true`,
    );
    await runner.query(`CREATE TABLE app_update_campaigns (
      id uuid PRIMARY KEY, "releaseId" bigint NOT NULL REFERENCES app_store_releases(id),
      title varchar(90) NOT NULL, body varchar(300) NOT NULL, active boolean NOT NULL DEFAULT true,
      "createdBy" uuid REFERENCES users(id) ON DELETE SET NULL, "createdAt" timestamptz NOT NULL DEFAULT now()
    )`);
    await runner.query(
      `CREATE INDEX app_update_campaigns_release_idx ON app_update_campaigns("releaseId")`,
    );
    await runner.query(
      `CREATE INDEX app_update_campaigns_author_idx ON app_update_campaigns("createdBy")`,
    );
    await runner.query(
      `CREATE INDEX app_update_campaigns_active_idx ON app_update_campaigns("createdAt") WHERE active = true`,
    );
  }
  async down(runner: QueryRunner): Promise<void> {
    await runner.query('DROP TABLE app_update_campaigns');
    await runner.query('DROP TABLE app_update_installations');
  }
}
