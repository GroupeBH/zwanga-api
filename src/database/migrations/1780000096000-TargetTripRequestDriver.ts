import { MigrationInterface, QueryRunner } from 'typeorm';

export class TargetTripRequestDriver1780000096000 implements MigrationInterface {
  name = 'TargetTripRequestDriver1780000096000';
  async up(runner: QueryRunner): Promise<void> {
    await runner.query('ALTER TABLE trip_requests ADD COLUMN "targetDriverId" uuid NULL');
    await runner.query('ALTER TABLE trip_requests ADD CONSTRAINT "FK_request_target_driver" FOREIGN KEY ("targetDriverId") REFERENCES users(id) ON DELETE RESTRICT');
    await runner.query('CREATE INDEX "IDX_request_target_driver" ON trip_requests ("targetDriverId") WHERE "targetDriverId" IS NOT NULL');
  }
  async down(runner: QueryRunner): Promise<void> {
    // Never turn an outstanding private request into a public request through rollback.
    const [row] = await runner.query('SELECT count(*)::int AS count FROM trip_requests WHERE "targetDriverId" IS NOT NULL');
    if (row.count > 0) throw new Error('Targeted requests exist; refusing to remove their audience restriction.');
    await runner.query('ALTER TABLE trip_requests DROP COLUMN "targetDriverId"');
  }
}
