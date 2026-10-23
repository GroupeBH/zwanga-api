import { MigrationInterface, QueryRunner } from 'typeorm';

/** Prepared only: never run by application startup outside normal migrations. */
export class TokenCashFallback1780000091000 implements MigrationInterface {
  name = 'TokenCashFallback1780000091000';
  async up(runner: QueryRunner): Promise<void> {
    if (!runner.isTransactionActive) throw new Error('Cash fallback requires transactional migrations');
    await runner.query(`SET LOCAL lock_timeout = '5s'`);
    await runner.query(`SET LOCAL statement_timeout = '30s'`);
    await runner.query(`ALTER TABLE bookings ADD COLUMN "tokenCashFallbackAt" timestamptz NULL;
      ALTER TABLE bookings ADD CONSTRAINT "CHK_token_cash_fallback" CHECK (
        "tokenCashFallbackAt" IS NULL OR ("paymentMode" = 'cash' AND "paymentStatus" = 'not_required'
          AND "paidAt" IS NULL AND "mixedPaymentAt" IS NULL AND "paymentAmount" IS NOT NULL AND "paymentAmount" > 0)) NOT VALID;
      ALTER TABLE bookings VALIDATE CONSTRAINT "CHK_token_cash_fallback";
      CREATE FUNCTION zwanga_token_cash_fallback_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD."tokenCashFallbackAt" IS NOT NULL AND ROW(NEW."tokenCashFallbackAt",NEW."paymentAmount",NEW."paymentCurrency",NEW."passengerId",NEW."tripId")
          IS DISTINCT FROM ROW(OLD."tokenCashFallbackAt",OLD."paymentAmount",OLD."paymentCurrency",OLD."passengerId",OLD."tripId")
        THEN RAISE EXCEPTION 'TOKEN_CASH_FALLBACK_IMMUTABLE'; END IF;
        IF OLD."tokenCashFallbackAt" IS NULL AND NEW."tokenCashFallbackAt" IS NOT NULL AND
          (OLD."paymentStatus" = 'succeeded' OR OLD."cashReceivedAt" IS NOT NULL
            OR OLD."mixedPaymentAt" IS NOT NULL OR NEW.status <> 'completed' OR NOT NEW."droppedOff")
        THEN RAISE EXCEPTION 'TOKEN_CASH_FALLBACK_CONFLICT'; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER token_cash_fallback_guard BEFORE UPDATE ON bookings FOR EACH ROW EXECUTE FUNCTION zwanga_token_cash_fallback_guard();
      CREATE FUNCTION zwanga_token_cash_collection_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE fallback_at timestamptz;
      BEGIN
        IF (TG_TABLE_NAME = 'payment_transactions' AND NEW."relatedEntityType" = 'booking') OR
           (TG_TABLE_NAME = 'wallet_ledger_entries' AND NEW."relatedEntityType" = 'booking') THEN
          SELECT "tokenCashFallbackAt" INTO fallback_at FROM bookings WHERE id = NEW."relatedEntityId"::uuid FOR UPDATE;
          IF fallback_at IS NOT NULL THEN RAISE EXCEPTION 'TOKEN_CASH_FALLBACK_NO_SECOND_COLLECTION'; END IF;
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER token_cash_provider_guard BEFORE INSERT ON payment_transactions FOR EACH ROW
        WHEN (NEW.purpose = 'trip_booking') EXECUTE FUNCTION zwanga_token_cash_collection_guard();
      CREATE TRIGGER token_cash_wallet_guard BEFORE INSERT ON wallet_ledger_entries FOR EACH ROW
        WHEN (NEW.type = 'booking_payment') EXECUTE FUNCTION zwanga_token_cash_collection_guard();`);
  }
  async down(): Promise<void> {
    throw new Error('Preserve cash choices and late-payment fencing; use a reviewed forward migration.');
  }
}
