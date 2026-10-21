import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Persist future earned-reward work with the booking commit, including cash receipts.
 * No historical cash backfill: the job is also the cash-policy eligibility marker. */
export class ReferralBookingRecovery1780000086000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    if (!runner.isTransactionActive) throw new Error('Referral recovery requires a transaction');
    await runner.query("SET LOCAL lock_timeout = '5s'");
    await runner.query("SET LOCAL statement_timeout = '30s'");
    await runner.query(`CREATE TABLE referral_booking_jobs (
      "bookingId" uuid PRIMARY KEY REFERENCES bookings(id) ON DELETE RESTRICT,
      "cashEligible" boolean NOT NULL DEFAULT false,
      "nextAttemptAt" timestamptz NOT NULL DEFAULT now(),
      attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
      "leaseToken" uuid, "leaseUntil" timestamptz,
      "completedAt" timestamptz, "lastError" varchar(100),
      "createdAt" timestamptz NOT NULL DEFAULT now()
    )`);
    await runner.query(`CREATE INDEX "IDX_referral_booking_jobs_due" ON referral_booking_jobs
      ("nextAttemptAt", "bookingId") WHERE "completedAt" IS NULL`);
    await runner.query(`CREATE FUNCTION zwanga_queue_booking_referral() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE cash_eligible boolean := false;
      BEGIN
        IF NEW.status <> 'completed' OR NOT NEW."droppedOff" OR COALESCE(NEW."paymentAmount",0) <= 0 THEN RETURN NEW; END IF;
        IF NEW."paymentMode" = 'cash' THEN
          IF NEW."cashReceivedAt" IS NULL OR NEW."paymentStatus" <> 'not_required' THEN RETURN NEW; END IF;
          -- A repeated save of a historical receipt must NOT activate cash retroactively.
          IF TG_OP = 'UPDATE' THEN
            IF OLD."cashReceivedAt" IS NOT NULL THEN RETURN NEW; END IF;
          END IF;
          cash_eligible := true;
        ELSIF NEW."paymentMode" NOT IN ('electronic','points') OR NEW."paymentStatus" <> 'succeeded' THEN RETURN NEW;
        ELSIF TG_OP = 'UPDATE' THEN
          IF NEW.status IS NOT DISTINCT FROM OLD.status AND NEW."droppedOff" IS NOT DISTINCT FROM OLD."droppedOff"
            AND NEW."paymentMode" IS NOT DISTINCT FROM OLD."paymentMode"
            AND NEW."paymentStatus" IS NOT DISTINCT FROM OLD."paymentStatus"
            AND NEW."paymentAmount" IS NOT DISTINCT FROM OLD."paymentAmount"
            AND NEW."paymentCurrency" IS NOT DISTINCT FROM OLD."paymentCurrency" THEN RETURN NEW; END IF;
        END IF;
        INSERT INTO referral_booking_jobs ("bookingId", "cashEligible") VALUES (NEW.id, cash_eligible)
          ON CONFLICT ("bookingId") DO UPDATE SET revision = referral_booking_jobs.revision + 1,
            "cashEligible" = referral_booking_jobs."cashEligible" OR EXCLUDED."cashEligible",
            "completedAt" = NULL, "lastError" = NULL, "nextAttemptAt" = now();
        RETURN NEW;
      END $$`);
    await runner.query(`CREATE TRIGGER zwanga_queue_booking_referral AFTER INSERT OR UPDATE OF
      status, "droppedOff", "paymentMode", "paymentStatus", "paymentAmount", "paymentCurrency", "cashReceivedAt"
      ON bookings FOR EACH ROW EXECUTE FUNCTION zwanga_queue_booking_referral()`);
  }

  async down(runner: QueryRunner): Promise<void> {
    if (!runner.isTransactionActive) throw new Error('Referral recovery requires a transaction');
    await runner.query("SET LOCAL lock_timeout = '5s'");
    await runner.query("SET LOCAL statement_timeout = '30s'");
    await runner.query('LOCK TABLE bookings IN SHARE ROW EXCLUSIVE MODE');
    await runner.query('LOCK TABLE referral_booking_jobs IN ACCESS EXCLUSIVE MODE');
    const [row] = await runner.query('SELECT EXISTS (SELECT 1 FROM referral_booking_jobs) AS used');
    if (row.used) throw new Error('Referral work exists; do not discard recovery or cash eligibility. Use a forward correction.');
    await runner.query('DROP TRIGGER zwanga_queue_booking_referral ON bookings');
    await runner.query('DROP FUNCTION zwanga_queue_booking_referral()');
    await runner.query('DROP TABLE referral_booking_jobs');
  }
}
