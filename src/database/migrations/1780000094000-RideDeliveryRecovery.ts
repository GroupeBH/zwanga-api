import type { MigrationInterface, QueryRunner } from 'typeorm';
export class RideDeliveryRecovery1780000094000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> { await this.withBudget(runner, () => this.applyUp(runner)); }
  private async applyUp(runner: QueryRunner): Promise<void> {
    await runner.query(`ALTER TABLE ride_notification_receipts
      ADD COLUMN "clientObservedAt" timestamptz,
      ADD COLUMN source varchar(16), ADD COLUMN "failureCode" varchar(40)`);
    await runner.query(`CREATE TABLE ride_notification_retries (
      "notificationId" uuid PRIMARY KEY REFERENCES notifications(id) ON DELETE CASCADE,
      "retriedAt" timestamptz NOT NULL DEFAULT clock_timestamp())`);
    await runner.query(`CREATE INDEX idx_ride_native_sent_recovery ON notifications ("updatedAt", id)
      WHERE status = 'sent' AND "isActive" = true AND data ->> 'nativeDeliveryVersion' = '6'`);
  }
  async down(runner: QueryRunner): Promise<void> { await this.withBudget(runner, () => this.applyDown(runner)); }
  private async applyDown(runner: QueryRunner): Promise<void> {
    await runner.query('DROP INDEX idx_ride_native_sent_recovery');
    await runner.query('DROP TABLE ride_notification_retries');
    await runner.query('ALTER TABLE ride_notification_receipts DROP COLUMN "clientObservedAt", DROP COLUMN source, DROP COLUMN "failureCode"');
  }
  private async withBudget(runner: QueryRunner, work: () => Promise<void>): Promise<void> {
    const ownsTransaction = !runner.isTransactionActive;
    if (ownsTransaction) await runner.startTransaction();
    try {
      const [previous] = await runner.query(`SELECT current_setting('lock_timeout') AS lock_timeout,
        current_setting('statement_timeout') AS statement_timeout`);
      // DDL remains transactional. Fail and roll back instead of waiting
      // indefinitely behind production traffic. These are per-statement limits.
      await runner.query("SELECT set_config('lock_timeout', '3s', true), set_config('statement_timeout', '15s', true)");
      await work();
      await runner.query("SELECT set_config('lock_timeout', $1, true), set_config('statement_timeout', $2, true)",
        [previous.lock_timeout, previous.statement_timeout]);
      if (ownsTransaction) await runner.commitTransaction();
    } catch (error) {
      if (ownsTransaction && runner.isTransactionActive) await runner.rollbackTransaction();
      throw error;
    }
  }
}
