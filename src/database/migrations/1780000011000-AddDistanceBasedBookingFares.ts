import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddDistanceBasedBookingFares1780000011000
  implements MigrationInterface
{
  name = 'AddDistanceBasedBookingFares1780000011000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE bookings
      ADD COLUMN IF NOT EXISTS "originalPaymentAmount" numeric(10, 2),
      ADD COLUMN IF NOT EXISTS "plannedDistanceMeters" integer,
      ADD COLUMN IF NOT EXISTS "travelledDistanceMeters" integer,
      ADD COLUMN IF NOT EXISTS "pricePerKilometer" numeric(12, 2),
      ADD COLUMN IF NOT EXISTS "fareAdjustmentAmount" numeric(10, 2),
      ADD COLUMN IF NOT EXISTS "fareAdjustedAt" timestamp;
    `);

    await queryRunner.query(`
      ALTER TABLE wallet_ledger_entries
      DROP CONSTRAINT IF EXISTS "CHK_wallet_ledger_type";
    `);
    await queryRunner.query(`
      ALTER TABLE wallet_ledger_entries
      ADD CONSTRAINT "CHK_wallet_ledger_type"
      CHECK (type IN (
        'top_up',
        'loyalty_reward',
        'booking_payment',
        'booking_refund',
        'booking_fare_adjustment'
      ));
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE wallet_ledger_entries
      DROP CONSTRAINT IF EXISTS "CHK_wallet_ledger_type";
    `);
    await queryRunner.query(`
      ALTER TABLE wallet_ledger_entries
      ADD CONSTRAINT "CHK_wallet_ledger_type"
      CHECK (type IN (
        'top_up',
        'loyalty_reward',
        'booking_payment',
        'booking_refund'
      ));
    `);

    await queryRunner.query(`
      ALTER TABLE bookings
      DROP COLUMN IF EXISTS "fareAdjustedAt",
      DROP COLUMN IF EXISTS "fareAdjustmentAmount",
      DROP COLUMN IF EXISTS "pricePerKilometer",
      DROP COLUMN IF EXISTS "travelledDistanceMeters",
      DROP COLUMN IF EXISTS "plannedDistanceMeters",
      DROP COLUMN IF EXISTS "originalPaymentAmount";
    `);
  }
}
