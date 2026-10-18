import type { MigrationInterface, QueryRunner } from 'typeorm';

export class BroadcastDriverRequests1780000074000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await this.withBudget(runner, () => this.applyUp(runner));
  }

  private async applyUp(runner: QueryRunner): Promise<void> {
    // Keep (requestId, driverId) unique and one pending offer per driver.
    // respond() locks the request row to serialize competing acceptances.
    await runner.query('DROP INDEX dispatch_one_pending_request_idx');
    await runner.query(`CREATE INDEX dispatch_pending_request_idx
      ON trip_request_dispatch_offers ("requestId") WHERE status = 'pending'`);
    await runner.query(`CREATE INDEX dispatch_broadcast_requests_idx
      ON trip_requests ("dispatchCheckedAt" NULLS FIRST, "createdAt")
      WHERE status IN ('pending', 'offers_received')`);
    await runner.query(`ALTER TABLE driver_dispatch_presence ADD COLUMN "locationReminderSentAt" timestamptz`);
    await runner.query(`CREATE INDEX dispatch_location_reminder_idx
      ON driver_dispatch_presence ("updatedAt", "driverId") WHERE "locationReminderSentAt" IS NULL`);
  }

  async down(runner: QueryRunner): Promise<void> {
    await this.withBudget(runner, () => this.applyDown(runner));
  }

  private async applyDown(runner: QueryRunner): Promise<void> {
    // Never cancel live invitations merely to make rollback fit.
    await runner.query(`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM trip_request_dispatch_offers WHERE status = 'pending'
        GROUP BY "requestId" HAVING count(*) > 1) THEN
        RAISE EXCEPTION 'Broadcast invitations still pending; stop dispatch and wait for expiry before rollback';
      END IF;
    END $$`);
    await runner.query(`CREATE UNIQUE INDEX dispatch_one_pending_request_idx
      ON trip_request_dispatch_offers ("requestId") WHERE status = 'pending'`);
    await runner.query('DROP INDEX dispatch_pending_request_idx');
    await runner.query('DROP INDEX dispatch_broadcast_requests_idx');
    await runner.query('DROP INDEX dispatch_location_reminder_idx');
    await runner.query('ALTER TABLE driver_dispatch_presence DROP COLUMN "locationReminderSentAt"');
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
