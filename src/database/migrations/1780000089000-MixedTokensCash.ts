import { MigrationInterface, QueryRunner } from 'typeorm';

/** Additive: existing cash receipt constraints and commission triggers are unchanged. */
export class MixedTokensCash1780000089000 implements MigrationInterface {
  name = 'MixedTokensCash1780000089000';
  async up(runner: QueryRunner): Promise<void> {
    if (!runner.isTransactionActive)
      throw new Error('Mixed payments require transactional migrations');
    await runner.query(`SET LOCAL lock_timeout = '5s'`);
    await runner.query(`SET LOCAL statement_timeout = '30s'`);
    await runner.query(`ALTER TABLE bookings
      ADD COLUMN "mixedTokenAmount" numeric(10,2) NOT NULL DEFAULT 0,
      ADD COLUMN "mixedTokenQuantity" numeric(12,2) NOT NULL DEFAULT 0,
      ADD COLUMN "mixedPaymentAt" timestamptz NULL;
      ALTER TABLE bookings ADD CONSTRAINT "CHK_booking_mixed_cash" CHECK (
        ("mixedPaymentAt" IS NULL AND "mixedTokenAmount" = 0 AND "mixedTokenQuantity" = 0) OR
        ("mixedPaymentAt" IS NOT NULL AND "paymentAmount" IS NOT NULL AND "paymentAmount" > 0
          AND "cashCommissionTokenValue" > 0 AND "mixedTokenAmount" > 0 AND "mixedTokenQuantity" > 0
          AND "mixedTokenAmount" <> 'NaN'::numeric AND "mixedTokenQuantity" <> 'NaN'::numeric
          AND "mixedTokenAmount" = round("mixedTokenQuantity" * "cashCommissionTokenValue",2)
          AND "paymentMode" = 'cash' AND "paymentStatus" = 'not_required' AND "paymentCurrency" = 'CDF'
          AND status = 'completed' AND "droppedOff" = true)) NOT VALID;
      ALTER TABLE bookings VALIDATE CONSTRAINT "CHK_booking_mixed_cash";
      CREATE FUNCTION zwanga_mixed_cash_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD."mixedPaymentAt" IS NOT NULL AND
          ROW(NEW."mixedTokenAmount",NEW."mixedTokenQuantity",NEW."mixedPaymentAt",NEW."paymentAmount",NEW."grossPaymentAmount",
            NEW."zwangaSubsidyAmount",NEW."paymentCurrency",NEW."cashCommissionTokenValue",NEW."paymentMode",NEW."paymentStatus",NEW."passengerId",NEW."tripId")
          IS DISTINCT FROM ROW(OLD."mixedTokenAmount",OLD."mixedTokenQuantity",OLD."mixedPaymentAt",OLD."paymentAmount",OLD."grossPaymentAmount",
            OLD."zwangaSubsidyAmount",OLD."paymentCurrency",OLD."cashCommissionTokenValue",OLD."paymentMode",OLD."paymentStatus",OLD."passengerId",OLD."tripId")
        THEN RAISE EXCEPTION 'MIXED_PAYMENT_IMMUTABLE'; END IF;
        IF OLD."mixedPaymentAt" IS NULL AND NEW."mixedPaymentAt" IS NOT NULL AND
          (OLD."cashReceivedAt" IS NOT NULL OR OLD."paymentStatus" = 'succeeded' OR
            OLD."paymentAmount" <> NEW."paymentAmount" + NEW."mixedTokenAmount")
        THEN RAISE EXCEPTION 'MIXED_PAYMENT_CONFLICT'; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER mixed_cash_guard BEFORE UPDATE ON bookings FOR EACH ROW EXECUTE FUNCTION zwanga_mixed_cash_guard();
      CREATE FUNCTION zwanga_mixed_provider_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE mixed_at timestamptz;
      BEGIN
        IF NEW.purpose = 'trip_booking' AND NEW."relatedEntityType" = 'booking' THEN
          SELECT "mixedPaymentAt" INTO mixed_at FROM bookings WHERE id = NEW."relatedEntityId"::uuid FOR UPDATE;
          IF mixed_at IS NOT NULL THEN RAISE EXCEPTION 'MIXED_PAYMENT_ALREADY_PAID'; END IF;
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER mixed_provider_guard BEFORE INSERT ON payment_transactions FOR EACH ROW EXECUTE FUNCTION zwanga_mixed_provider_guard();`);
  }
  async down(runner: QueryRunner): Promise<void> {
    if (!runner.isTransactionActive)
      throw new Error('Mixed payments require transactional migrations');
    await runner.query(`SET LOCAL lock_timeout = '5s'`);
    await runner.query(`LOCK TABLE bookings IN ACCESS EXCLUSIVE MODE`);
    const [row] = (await runner.query(
      `SELECT EXISTS(SELECT 1 FROM bookings WHERE "mixedPaymentAt" IS NOT NULL) AS used`,
    )) as { used: boolean }[];
    if (row.used)
      throw new Error(
        'Cannot erase paid token portions. Preserve the ledger and use a forward fix.',
      );
    await runner.query(`DROP TRIGGER mixed_provider_guard ON payment_transactions;
      DROP FUNCTION zwanga_mixed_provider_guard();
      DROP TRIGGER mixed_cash_guard ON bookings;
      DROP FUNCTION zwanga_mixed_cash_guard();
      ALTER TABLE bookings DROP CONSTRAINT "CHK_booking_mixed_cash",
        DROP COLUMN "mixedPaymentAt", DROP COLUMN "mixedTokenQuantity", DROP COLUMN "mixedTokenAmount";`);
  }
}
