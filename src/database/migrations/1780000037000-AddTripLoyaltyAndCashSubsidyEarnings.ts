import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddTripLoyaltyAndCashSubsidyEarnings1780000037000 implements MigrationInterface {
  name = 'AddTripLoyaltyAndCashSubsidyEarnings1780000037000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Fail rather than queue a long exclusive lock behind production traffic.
    await queryRunner.query(`SET LOCAL lock_timeout = '5s';`);
    // Cash is only recorded by the service for the Zwanga-funded subsidy,
    // never for the cash collected directly by the driver.
    await queryRunner.query(`
      ALTER TABLE driver_earnings
      DROP CONSTRAINT IF EXISTS "CHK_driver_earnings_payment_mode";
    `);
    await queryRunner.query(`
      ALTER TABLE driver_earnings
      ADD CONSTRAINT "CHK_driver_earnings_payment_mode"
      CHECK ("paymentMode" IN ('electronic', 'points', 'cash')) NOT VALID;
    `);
    await queryRunner.query(`
      ALTER TABLE driver_earnings
      VALIDATE CONSTRAINT "CHK_driver_earnings_payment_mode";
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_bookings_cash_subsidy_recovery"
      ON bookings (id)
      WHERE "paymentMode" = 'cash' AND "firstTripSubsidyApplied" = true
        AND "zwangaSubsidyAmount" > 0 AND status IN ('accepted', 'completed')
        AND (status = 'completed' OR "droppedOff" = true OR "droppedOffAt" IS NOT NULL);
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_wallet_ledger_trip_loyalty"
      ON wallet_ledger_entries ("userId", "relatedEntityType", "relatedEntityId")
      WHERE type = 'loyalty_reward'
        AND "relatedEntityType" IN ('trip_loyalty_base', 'trip_loyalty_bonus');
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Never erase credits or delete legitimate cash subsidies to force rollback.
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM driver_earnings WHERE "paymentMode" = 'cash')
          OR EXISTS (
            SELECT 1 FROM wallet_ledger_entries WHERE type = 'loyalty_reward'
              AND "relatedEntityType" IN ('trip_loyalty_base', 'trip_loyalty_bonus')
          ) THEN
          RAISE EXCEPTION 'Rollback refused: cash subsidy earnings or trip loyalty credits exist';
        END IF;
      END $$;
    `);
    await queryRunner.query(
      `DROP INDEX IF EXISTS "UQ_wallet_ledger_trip_loyalty";`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_bookings_cash_subsidy_recovery";`);
    await queryRunner.query(
      `ALTER TABLE driver_earnings DROP CONSTRAINT "CHK_driver_earnings_payment_mode";`,
    );
    await queryRunner.query(`
      ALTER TABLE driver_earnings ADD CONSTRAINT "CHK_driver_earnings_payment_mode"
      CHECK ("paymentMode" IN ('electronic', 'points'));
    `);
  }
}
