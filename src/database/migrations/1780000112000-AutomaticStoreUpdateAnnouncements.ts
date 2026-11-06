import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AutomaticStoreUpdateAnnouncements1780000112000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE app_store_releases
      ADD COLUMN source varchar(10) NOT NULL DEFAULT 'admin' CHECK (source IN ('admin','store')),
      ADD COLUMN comparison varchar(20) NOT NULL DEFAULT 'version_build'
        CHECK (comparison IN ('version_build','native_build'))`);
  }
  async down(q: QueryRunner): Promise<void> {
    // Older binaries cannot interpret build-only announcements. Retain their
    // audit/history, but stop delivering them before dropping the metadata.
    await q.query(
      "UPDATE app_store_releases SET available=false WHERE source='store'",
    );
    await q.query(
      'ALTER TABLE app_store_releases DROP COLUMN comparison, DROP COLUMN source',
    );
  }
}
