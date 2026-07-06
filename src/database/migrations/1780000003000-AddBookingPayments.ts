import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddBookingPayments1780000003000 implements MigrationInterface {
  name = 'AddBookingPayments1780000003000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_type
          WHERE typname = 'bookings_payment_status_enum'
        ) THEN
          CREATE TYPE "bookings_payment_status_enum" AS ENUM (
            'not_required',
            'pending',
            'initiated',
            'succeeded',
            'failed',
            'cancelled'
          );
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      ALTER TABLE bookings
      ADD COLUMN IF NOT EXISTS "paymentStatus" "bookings_payment_status_enum" NOT NULL DEFAULT 'not_required',
      ADD COLUMN IF NOT EXISTS "paymentAmount" numeric(10, 2),
      ADD COLUMN IF NOT EXISTS "paymentCurrency" character varying(8) NOT NULL DEFAULT 'CDF',
      ADD COLUMN IF NOT EXISTS "paymentReference" character varying(120),
      ADD COLUMN IF NOT EXISTS "paymentTransactionId" uuid,
      ADD COLUMN IF NOT EXISTS "paidAt" timestamp;
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_bookings_payment_reference"
      ON bookings ("paymentReference");
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_bookings_payment_transaction_id"
      ON bookings ("paymentTransactionId");
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conname = 'FK_bookings_payment_transaction'
        ) THEN
          ALTER TABLE bookings
          ADD CONSTRAINT "FK_bookings_payment_transaction"
          FOREIGN KEY ("paymentTransactionId")
          REFERENCES payment_transactions(id)
          ON DELETE SET NULL;
        END IF;
      END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE bookings
      DROP CONSTRAINT IF EXISTS "FK_bookings_payment_transaction";
    `);

    await queryRunner.query(`
      DROP INDEX IF EXISTS "IDX_bookings_payment_transaction_id";
    `);

    await queryRunner.query(`
      DROP INDEX IF EXISTS "IDX_bookings_payment_reference";
    `);

    await queryRunner.query(`
      ALTER TABLE bookings
      DROP COLUMN IF EXISTS "paidAt",
      DROP COLUMN IF EXISTS "paymentTransactionId",
      DROP COLUMN IF EXISTS "paymentReference",
      DROP COLUMN IF EXISTS "paymentCurrency",
      DROP COLUMN IF EXISTS "paymentAmount",
      DROP COLUMN IF EXISTS "paymentStatus";
    `);

    await queryRunner.query(`
      DROP TYPE IF EXISTS "bookings_payment_status_enum";
    `);
  }
}
