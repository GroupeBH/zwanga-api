import { MigrationInterface, QueryRunner } from 'typeorm';

export class AlertDeliveryReliability1780000106000 implements MigrationInterface {
  name = 'AlertDeliveryReliability1780000106000';
  async up(runner: QueryRunner): Promise<void> {
    await this.budget(runner);
    await runner.query(`ALTER TABLE notifications
      ADD COLUMN "pushAttempts" integer NOT NULL DEFAULT 0,
      ADD COLUMN "pushRetryAt" timestamptz,
      ADD COLUMN "pushPermanentFailure" boolean NOT NULL DEFAULT false`);
    await runner.query(
      `ALTER TABLE ride_notification_receipts ADD COLUMN "audioEvents" jsonb NOT NULL DEFAULT '{}'::jsonb`,
    );
  }
  async down(runner: QueryRunner): Promise<void> {
    await this.budget(runner);
    await runner.query(
      `ALTER TABLE ride_notification_receipts DROP COLUMN "audioEvents"`,
    );
    await runner.query(
      `ALTER TABLE notifications DROP COLUMN "pushAttempts", DROP COLUMN "pushRetryAt", DROP COLUMN "pushPermanentFailure"`,
    );
  }
  private async budget(runner: QueryRunner) {
    if (!runner.isTransactionActive)
      throw new Error('Alert reliability migration requires a transaction');
    await runner.query("SET LOCAL lock_timeout = '5s'");
    await runner.query("SET LOCAL statement_timeout = '15s'");
  }
}
