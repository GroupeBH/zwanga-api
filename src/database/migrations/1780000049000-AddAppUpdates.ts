import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddAppUpdates1780000049000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`CREATE TABLE app_store_releases (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      platform varchar(7) NOT NULL CHECK (platform IN ('ios','android')),
      version varchar(32) NOT NULL CHECK (version ~ '^[0-9]+[.][0-9]+[.][0-9]+$'),
      build varchar(32) NOT NULL CHECK (build ~ '^[0-9]+[.][0-9]+[.][0-9]+$'),
      notes varchar(500) NOT NULL DEFAULT '', available boolean NOT NULL DEFAULT true,
      "publishedAt" timestamptz NOT NULL DEFAULT now(),
      "publishedBy" uuid REFERENCES users(id) ON DELETE SET NULL,
      UNIQUE (platform, version, build)
    )`);
    await runner.query(`CREATE UNIQUE INDEX app_release_active_platform_idx ON app_store_releases(platform) WHERE available = true`);
    await runner.query(`CREATE INDEX app_release_author_idx ON app_store_releases("publishedBy")`);
    await runner.query(`CREATE TABLE app_update_clients (
      "userId" uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      platform varchar(7) NOT NULL CHECK (platform IN ('ios','android')),
      version varchar(32) NOT NULL CHECK (version ~ '^[0-9]+[.][0-9]+[.][0-9]+$'),
      build varchar(32) NOT NULL CHECK (build ~ '^[0-9]+[.][0-9]+[.][0-9]+$'),
      "tokenHash" varchar(64), "updatedAt" timestamptz NOT NULL DEFAULT now()
    )`);
    await runner.query(`CREATE INDEX app_update_clients_platform_user_idx ON app_update_clients(platform, "userId") WHERE "tokenHash" IS NOT NULL`);
  }
  async down(runner: QueryRunner): Promise<void> {
    await runner.query('DROP TABLE IF EXISTS app_update_clients');
    await runner.query('DROP TABLE IF EXISTS app_store_releases');
  }
}
