import type { MigrationInterface, QueryRunner } from 'typeorm';

export class MapDriverPriority1780000103000 implements MigrationInterface {
  async up(runner: QueryRunner) {
    await runner.query(
      'ALTER TABLE trip_requests ADD COLUMN "targetDriverPriorityUntil" timestamptz NULL',
    );
    await runner.query(
      'CREATE INDEX "IDX_request_target_priority" ON trip_requests ("targetDriverPriorityUntil") WHERE "targetDriverPriorityUntil" IS NOT NULL',
    );
  }
  async down(runner: QueryRunner) {
    const rows: unknown =
      await runner.query(`SELECT 1 FROM trip_requests WHERE "targetDriverPriorityUntil" IS NOT NULL
      AND "selectedDriverId" IS NULL AND status IN ('pending','offers_received') LIMIT 1`);
    if (!Array.isArray(rows) || rows.length > 0)
      throw new Error('Finish or reopen targeted searches before rollback.');
    await runner.query(
      'ALTER TABLE trip_requests DROP COLUMN "targetDriverPriorityUntil"',
    );
  }
}
