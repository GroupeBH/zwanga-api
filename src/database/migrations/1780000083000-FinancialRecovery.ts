import { MigrationInterface, QueryRunner } from 'typeorm';

/** Extend the existing durable queue, without repricing or replaying historical credits. */
export class FinancialRecovery1780000083000 implements MigrationInterface {
  name = 'FinancialRecovery1780000083000';

  async up(runner: QueryRunner): Promise<void> {
    if (!runner.isTransactionActive)
      throw new Error('Financial recovery migration requires a transaction');
    await runner.query("SET LOCAL lock_timeout = '5s'");
    await runner.query("SET LOCAL statement_timeout = '30s'");
    // Version the queue storage, not the worker design: old workers consider non-FlexPay
    // jobs complete and must never be allowed to claim these new settlement jobs.
    await runner.query(
      `CREATE TABLE payment_settlement_jobs (LIKE payment_reconciliation_jobs INCLUDING ALL)`,
    );
    await runner.query(`ALTER TABLE payment_settlement_jobs ADD CONSTRAINT "FK_payment_settlement_job"
      FOREIGN KEY ("paymentId") REFERENCES payment_transactions(id) ON DELETE CASCADE`);
    await runner.query(`INSERT INTO payment_settlement_jobs ("paymentId", "nextAttemptAt")
      SELECT "paymentId", now() FROM payment_reconciliation_jobs WHERE "completedAt" IS NULL`);
    await runner.query(
      `ALTER TABLE referral_withdrawals ADD COLUMN "recoveryCheckedAt" timestamptz`,
    );
    await runner.query(`CREATE INDEX "IDX_referral_withdrawals_orphans"
      ON referral_withdrawals ("recoveryCheckedAt" NULLS FIRST, "requestedAt")
      WHERE status = 'pending' AND "paymentTransactionId" IS NULL`);
    await runner.query(`CREATE INDEX "IDX_referral_rewards_due"
      ON referral_rewards ("holdUntil", id) WHERE status = 'pending'`);
    // Both old and new API revisions must serialize submission against reservation release.
    await runner.query(`CREATE FUNCTION zwanga_guard_referral_payout_submission() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE w referral_withdrawals%ROWTYPE;
      BEGIN
        IF NEW.purpose <> 'referral_payout' THEN RETURN NEW; END IF;
        IF NEW."relatedEntityType" IS DISTINCT FROM 'referral_withdrawal' OR NEW."relatedEntityId" IS NULL THEN
          RAISE EXCEPTION 'Unbound referral payout';
        END IF;
        PERFORM id FROM users WHERE id = NEW."userId" FOR UPDATE;
        SELECT * INTO w FROM referral_withdrawals WHERE id = NEW."relatedEntityId"::uuid FOR UPDATE;
        IF NOT FOUND OR w."userId" IS DISTINCT FROM NEW."userId" OR w.status <> 'pending'
          OR w.amount IS DISTINCT FROM NEW.amount OR w.currency IS DISTINCT FROM NEW.currency
          OR w.phone IS DISTINCT FROM NEW.phone OR w."paymentTransactionId" IS NOT NULL THEN
          RAISE EXCEPTION 'Referral payout is not sendable';
        END IF;
        IF EXISTS (SELECT 1 FROM payment_transactions WHERE "relatedEntityType" = 'referral_withdrawal'
          AND "relatedEntityId" = NEW."relatedEntityId") THEN
          RAISE EXCEPTION 'Referral payout already submitted';
        END IF;
        RETURN NEW;
      END $$`);
    await runner.query(`CREATE TRIGGER zwanga_guard_referral_payout_submission
      BEFORE INSERT ON payment_transactions FOR EACH ROW EXECUTE FUNCTION zwanga_guard_referral_payout_submission()`);
    await runner.query(`CREATE FUNCTION zwanga_queue_payment_settlement() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'UPDATE' THEN
          IF NEW.status IS NOT DISTINCT FROM OLD.status
            AND NEW."orderNumber" IS NOT DISTINCT FROM OLD."orderNumber"
            AND NEW.provider IS NOT DISTINCT FROM OLD.provider THEN RETURN NEW; END IF;
        END IF;
        IF NEW.provider IN ('flexpay','pawapay') AND NEW.purpose IN
          ('generic','subscription_pro','trip_booking','wallet_top_up','driver_payout','wallet_payout','referral_payout') THEN
          INSERT INTO payment_settlement_jobs ("paymentId", "nextAttemptAt")
          VALUES (NEW.id, now() + interval '1 minute')
          ON CONFLICT ("paymentId") DO UPDATE SET
            revision = payment_settlement_jobs.revision + 1,
            "completedAt" = NULL, "lastError" = NULL, "nextAttemptAt" = EXCLUDED."nextAttemptAt";
        END IF;
        RETURN NEW;
      END $$`);
    await runner.query(
      `DROP TRIGGER zwanga_queue_flexpay_deposit ON payment_transactions`,
    );
    await runner.query(`CREATE TRIGGER zwanga_queue_payment_settlement
      AFTER INSERT OR UPDATE OF status, "orderNumber", provider ON payment_transactions
      FOR EACH ROW EXECUTE FUNCTION zwanga_queue_payment_settlement()`);
    // Only outstanding operations and explicit unsettled domain rows. No blanket history replay.
    await runner.query(`INSERT INTO payment_settlement_jobs ("paymentId")
      SELECT p.id FROM payment_transactions p WHERE p.provider IN ('flexpay','pawapay') AND (
        (p.status IN ('pending','initiated') AND p.purpose IN
          ('generic','subscription_pro','trip_booking','wallet_top_up','driver_payout','wallet_payout','referral_payout'))
        OR (p.purpose = 'wallet_top_up' AND p.status = 'succeeded' AND NOT EXISTS
          (SELECT 1 FROM wallet_ledger_entries l WHERE l."paymentTransactionId" = p.id AND l.type = 'top_up'))
        OR (p.purpose = 'subscription_pro' AND p.status = 'succeeded' AND EXISTS
          (SELECT 1 FROM subscriptions s WHERE (s."paymentTransactionId" = p.id OR s.id::text = p."relatedEntityId")
            AND s.status IN ('pending','payment_failed')))
        OR (p.purpose = 'referral_payout' AND EXISTS
          (SELECT 1 FROM referral_withdrawals w WHERE (w."paymentTransactionId" = p.id OR w.id::text = p."relatedEntityId")
            AND w.status IN ('pending','initiated')))
      ) ON CONFLICT ("paymentId") DO UPDATE SET "completedAt" = NULL, "nextAttemptAt" = now(),
        revision = payment_settlement_jobs.revision + 1`);
  }

  async down(): Promise<void> {
    throw new Error(
      'Use a forward migration: do not discard pending financial recovery or remove submission guards',
    );
  }
}
