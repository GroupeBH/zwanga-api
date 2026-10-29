import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Additive: preserve the former ride-only index for rolling releases/rollback. */
export class IndexRealtimePaymentReceipts1780000100000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await this.withBudget(runner, async () => {
      await runner.query(`CREATE INDEX IF NOT EXISTS "IDX_notifications_realtime_receipts"
        ON notifications ("createdAt", id) WHERE "eventKey" IS NOT NULL AND "isActive" = true
        AND (data ->> 'type' IN ('driver_dispatch_offer','trip_request_nearby','new_booking','driver_booking_payment_confirmed')
          OR (data ->> 'type' = 'cash_payment_confirmed' AND data ->> 'role' = 'driver'))`);
      const [index] = await runner.query(`SELECT i.indisvalid FROM pg_index i
        WHERE i.indexrelid=to_regclass('"IDX_notifications_realtime_receipts"')`);
      if (!index?.indisvalid) throw new Error('IDX_notifications_realtime_receipts is not valid');
    });
  }
  async down(runner: QueryRunner): Promise<void> {
    await this.withBudget(runner, () => runner.query('DROP INDEX IF EXISTS "IDX_notifications_realtime_receipts"'));
  }
  private async withBudget(runner: QueryRunner, work: () => Promise<unknown>): Promise<void> {
    const ownsTransaction = !runner.isTransactionActive;
    if (ownsTransaction) await runner.startTransaction();
    try {
      const [previous] = await runner.query(`SELECT current_setting('lock_timeout') AS lock_timeout,
        current_setting('statement_timeout') AS statement_timeout`);
      await runner.query("SELECT set_config('lock_timeout','3s',true), set_config('statement_timeout','30s',true)");
      await work();
      await runner.query("SELECT set_config('lock_timeout',$1,true), set_config('statement_timeout',$2,true)",
        [previous.lock_timeout, previous.statement_timeout]);
      if (ownsTransaction) await runner.commitTransaction();
    } catch (error) {
      if (ownsTransaction && runner.isTransactionActive) await runner.rollbackTransaction();
      throw error;
    }
  }
}
