import type { MigrationInterface, QueryRunner } from 'typeorm';

export class RequestResponsePhases1780000098000 implements MigrationInterface {
  async up(runner: QueryRunner) {
    await runner.query(`ALTER TABLE trip_request_dispatch_offers
      ADD COLUMN phase varchar(16) NOT NULL DEFAULT 'driver' CHECK (phase IN ('driver','passenger','accepting')),
      ADD COLUMN "acceptanceToken" uuid`);
  }
  async down(runner: QueryRunner) {
    const [row] = await runner.query(`SELECT count(*)::int AS count FROM trip_request_dispatch_offers
      WHERE status='pending' AND phase<>'driver'`);
    if (row.count) throw new Error('Finish passenger decisions and acceptance recovery before rollback.');
    await runner.query('ALTER TABLE trip_request_dispatch_offers DROP COLUMN phase, DROP COLUMN "acceptanceToken"');
  }
}
