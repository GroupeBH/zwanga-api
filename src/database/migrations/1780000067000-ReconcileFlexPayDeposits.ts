import { MigrationInterface, QueryRunner } from 'typeorm';

/** Additive outbox: old application revisions can keep writing payments safely. */
export class ReconcileFlexPayDeposits1780000067000 implements MigrationInterface {
  name = 'ReconcileFlexPayDeposits1780000067000';

  async up(runner: QueryRunner): Promise<void> {
    if (!runner.isTransactionActive)
      throw new Error('Payment reconciliation requires a transaction');
    await runner.query("SET LOCAL lock_timeout = '5s'");
    await runner.query("SET LOCAL statement_timeout = '30s'");
    await runner.query(`CREATE TABLE payment_reconciliation_jobs (
      "paymentId" uuid PRIMARY KEY REFERENCES payment_transactions(id) ON DELETE CASCADE,
      "nextAttemptAt" timestamptz NOT NULL DEFAULT now(),
      attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
      "leaseToken" uuid, "leaseUntil" timestamptz,
      "completedAt" timestamptz, "lastError" varchar(100),
      "createdAt" timestamptz NOT NULL DEFAULT now()
    )`);
    await runner.query(`CREATE INDEX "IDX_payment_reconciliation_due" ON payment_reconciliation_jobs
      ("nextAttemptAt", "paymentId") WHERE "completedAt" IS NULL`);
    await runner.query(`CREATE FUNCTION zwanga_queue_flexpay_deposit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'UPDATE' THEN
          IF NEW.status IS NOT DISTINCT FROM OLD.status
            AND NEW."orderNumber" IS NOT DISTINCT FROM OLD."orderNumber" THEN
            RETURN NEW;
          END IF;
        END IF;
        IF NEW.provider = 'flexpay' AND NEW.purpose IN ('generic','subscription_pro','trip_booking','wallet_top_up') THEN
          INSERT INTO payment_reconciliation_jobs ("paymentId", "nextAttemptAt")
          VALUES (NEW.id, now() + interval '1 minute')
          ON CONFLICT ("paymentId") DO UPDATE SET
            revision = payment_reconciliation_jobs.revision + 1,
            "completedAt" = NULL, "lastError" = NULL,
            "nextAttemptAt" = EXCLUDED."nextAttemptAt";
        END IF;
        RETURN NEW;
      END $$`);
    await runner.query(`CREATE TRIGGER zwanga_queue_flexpay_deposit
      AFTER INSERT OR UPDATE OF status, "orderNumber" ON payment_transactions
      FOR EACH ROW EXECUTE FUNCTION zwanga_queue_flexpay_deposit()`);
    // Recover outstanding deposits, never bulk replay historical completed payouts.
    await runner.query(`INSERT INTO payment_reconciliation_jobs ("paymentId")
      SELECT id FROM payment_transactions WHERE provider = 'flexpay'
        AND status IN ('pending','initiated')
        AND purpose IN ('generic','subscription_pro','trip_booking','wallet_top_up')
      ON CONFLICT DO NOTHING`);
  }

  async down(): Promise<void> {
    throw new Error(
      'Use a forward migration: deleting pending financial work is unsafe',
    );
  }
}
