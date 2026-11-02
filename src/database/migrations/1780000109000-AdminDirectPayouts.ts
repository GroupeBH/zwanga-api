import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Queue treasury transfers without rewriting existing provider/domain triggers. */
export class AdminDirectPayouts1780000109000 implements MigrationInterface {
  name = 'AdminDirectPayouts1780000109000';
  async up(runner: QueryRunner) {
    await this.budget(runner);
    await runner.query(`CREATE FUNCTION zwanga_queue_admin_payout() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.purpose <> 'admin_payout' THEN RETURN NEW; END IF;
        IF TG_OP = 'UPDATE' THEN
          IF NEW.status IS NOT DISTINCT FROM OLD.status AND NEW."orderNumber" IS NOT DISTINCT FROM OLD."orderNumber"
            AND NEW.provider IS NOT DISTINCT FROM OLD.provider THEN RETURN NEW; END IF;
        END IF;
        INSERT INTO payment_settlement_jobs ("paymentId", "nextAttemptAt") VALUES (NEW.id, now() + interval '1 minute')
        ON CONFLICT ("paymentId") DO UPDATE SET revision = payment_settlement_jobs.revision + 1,
          "completedAt" = NULL, "lastError" = NULL, "nextAttemptAt" = EXCLUDED."nextAttemptAt";
        RETURN NEW;
      END $$`);
    await runner.query(`CREATE TRIGGER zwanga_queue_admin_payout
      AFTER INSERT OR UPDATE OF status, "orderNumber", provider ON payment_transactions
      FOR EACH ROW EXECUTE FUNCTION zwanga_queue_admin_payout()`);
    await runner.query(`INSERT INTO payment_settlement_jobs ("paymentId")
      SELECT id FROM payment_transactions WHERE purpose = 'admin_payout' AND status IN ('pending','initiated')
      ON CONFLICT ("paymentId") DO NOTHING`);
  }
  async down(runner: QueryRunner) {
    await this.budget(runner);
    // Preserve financial history and queued jobs.
    await runner.query(
      'DROP TRIGGER zwanga_queue_admin_payout ON payment_transactions',
    );
    await runner.query('DROP FUNCTION zwanga_queue_admin_payout()');
  }
  private async budget(runner: QueryRunner) {
    if (!runner.isTransactionActive)
      throw new Error('Admin payout migration requires a transaction');
    await runner.query("SET LOCAL lock_timeout = '5s'");
    await runner.query("SET LOCAL statement_timeout = '15s'");
  }
}
