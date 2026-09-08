import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddFirstTripSubsidyToBookings1780000031000 implements MigrationInterface {
  name = 'AddFirstTripSubsidyToBookings1780000031000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE bookings
      ADD COLUMN IF NOT EXISTS "grossPaymentAmount" numeric(10, 2),
      ADD COLUMN IF NOT EXISTS "firstTripSubsidyApplied" boolean NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS "passengerPaymentRate" numeric(7, 6),
      ADD COLUMN IF NOT EXISTS "zwangaSubsidyAmount" numeric(10, 2) NOT NULL DEFAULT 0;
    `);

    await queryRunner.query(`
      UPDATE bookings
      SET "grossPaymentAmount" = "paymentAmount"
      WHERE "grossPaymentAmount" IS NULL
        AND "paymentAmount" IS NOT NULL;
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conname = 'CHK_bookings_zwanga_subsidy_non_negative'
            AND conrelid = 'public.bookings'::regclass
        ) THEN
          ALTER TABLE bookings
          ADD CONSTRAINT "CHK_bookings_zwanga_subsidy_non_negative"
          CHECK ("zwangaSubsidyAmount" >= 0) NOT VALID;
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conname = 'CHK_bookings_passenger_payment_rate_range'
            AND conrelid = 'public.bookings'::regclass
        ) THEN
          ALTER TABLE bookings
          ADD CONSTRAINT "CHK_bookings_passenger_payment_rate_range"
          CHECK (
            "passengerPaymentRate" IS NULL
            OR ("passengerPaymentRate" > 0 AND "passengerPaymentRate" <= 1)
          ) NOT VALID;
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conname = 'CHK_bookings_first_trip_subsidy_consistent'
            AND conrelid = 'public.bookings'::regclass
        ) THEN
          ALTER TABLE bookings
          ADD CONSTRAINT "CHK_bookings_first_trip_subsidy_consistent"
          CHECK (
            NOT "firstTripSubsidyApplied"
            OR (
              "grossPaymentAmount" IS NOT NULL
              AND "paymentAmount" IS NOT NULL
              AND "passengerPaymentRate" IS NOT NULL
              AND "passengerPaymentRate" < 1
              AND "grossPaymentAmount" >= 0
              AND "paymentAmount" >= 0
              AND "grossPaymentAmount" >= "paymentAmount"
            )
          ) NOT VALID;
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      DROP INDEX IF EXISTS "UQ_bookings_first_trip_subsidy_passenger_active";
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_bookings_first_trip_subsidy_passenger_active"
      ON bookings ("passengerId")
      WHERE "firstTripSubsidyApplied" = true
        AND status NOT IN (
          'cancelled',
          'rejected',
          'expired',
          'no_show',
          'boarding_uncertain'
        );
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_bookings_passenger_first_trip_history"
      ON bookings ("passengerId")
      WHERE status = 'completed'
        OR "droppedOff" = true
        OR "droppedOffConfirmedByPassenger" = true
        OR "paymentStatus" = 'succeeded';
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conname = 'CHK_bookings_zwanga_subsidy_non_negative'
            AND conrelid = 'public.bookings'::regclass
            AND NOT convalidated
        ) THEN
          ALTER TABLE bookings
          VALIDATE CONSTRAINT "CHK_bookings_zwanga_subsidy_non_negative";
        END IF;
      END $$;
    `);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conname = 'CHK_bookings_passenger_payment_rate_range'
            AND conrelid = 'public.bookings'::regclass
            AND NOT convalidated
        ) THEN
          ALTER TABLE bookings
          VALIDATE CONSTRAINT "CHK_bookings_passenger_payment_rate_range";
        END IF;
      END $$;
    `);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conname = 'CHK_bookings_first_trip_subsidy_consistent'
            AND conrelid = 'public.bookings'::regclass
            AND NOT convalidated
        ) THEN
          ALTER TABLE bookings
          VALIDATE CONSTRAINT "CHK_bookings_first_trip_subsidy_consistent";
        END IF;
      END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS "IDX_bookings_passenger_first_trip_history";
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS "UQ_bookings_first_trip_subsidy_passenger_active";
    `);
    await queryRunner.query(`
      ALTER TABLE bookings
      DROP CONSTRAINT IF EXISTS "CHK_bookings_first_trip_subsidy_consistent";
    `);
    await queryRunner.query(`
      ALTER TABLE bookings
      DROP CONSTRAINT IF EXISTS "CHK_bookings_passenger_payment_rate_range";
    `);
    await queryRunner.query(`
      ALTER TABLE bookings
      DROP CONSTRAINT IF EXISTS "CHK_bookings_zwanga_subsidy_non_negative";
    `);
    await queryRunner.query(`
      ALTER TABLE bookings
      DROP COLUMN IF EXISTS "zwangaSubsidyAmount",
      DROP COLUMN IF EXISTS "passengerPaymentRate",
      DROP COLUMN IF EXISTS "firstTripSubsidyApplied",
      DROP COLUMN IF EXISTS "grossPaymentAmount";
    `);
  }
}
