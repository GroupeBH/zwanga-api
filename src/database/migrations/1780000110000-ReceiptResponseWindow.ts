import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Additive; old workers/clients keep their 40s invitations. No active lease rewrite. */
export class ReceiptResponseWindow1780000110000 implements MigrationInterface {
  name = 'ReceiptResponseWindow1780000110000';
  async up(runner: QueryRunner) {
    if (!runner.isTransactionActive) throw new Error('Response window migration requires a transaction');
    await runner.query("SET LOCAL lock_timeout = '5s'");
    await runner.query("SET LOCAL statement_timeout = '15s'");
    await runner.query(`ALTER TABLE trip_request_dispatch_offers
      ADD COLUMN "deliveryDeadlineAt" timestamptz,
      ADD COLUMN "responseStartedAt" timestamptz`);
  }
  async down(runner: QueryRunner) {
    if (!runner.isTransactionActive) throw new Error('Response window migration requires a transaction');
    await runner.query("SET LOCAL lock_timeout = '5s'");
    await runner.query("SET LOCAL statement_timeout = '15s'");
    await runner.query(`ALTER TABLE trip_request_dispatch_offers
      DROP COLUMN "responseStartedAt", DROP COLUMN "deliveryDeadlineAt"`);
  }
}
