import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddTripPaymentModes1780000005000 implements MigrationInterface {
  name = 'AddTripPaymentModes1780000005000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE bookings
      ADD COLUMN IF NOT EXISTS "paymentMode" character varying(30) NOT NULL DEFAULT 'cash';
    `);

    await queryRunner.query(`
      ALTER TABLE trip_requests
      ADD COLUMN IF NOT EXISTS "paymentMode" character varying(30) NOT NULL DEFAULT 'cash';
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'bookings' AND column_name = 'paymentMethod'
        ) THEN
          UPDATE bookings
          SET "paymentMode" = 'electronic'
          WHERE "paymentMethod" IS NOT NULL;

          ALTER TABLE bookings
          DROP CONSTRAINT IF EXISTS "CHK_bookings_payment_method";
          ALTER TABLE bookings DROP COLUMN "paymentMethod";
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'trip_requests' AND column_name = 'paymentMethod'
        ) THEN
          UPDATE trip_requests
          SET "paymentMode" = 'electronic'
          WHERE "paymentMethod" IS NOT NULL;

          ALTER TABLE trip_requests
          DROP CONSTRAINT IF EXISTS "CHK_trip_requests_payment_method";
          ALTER TABLE trip_requests DROP COLUMN "paymentMethod";
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'CHK_bookings_payment_mode'
        ) THEN
          ALTER TABLE bookings
          ADD CONSTRAINT "CHK_bookings_payment_mode"
          CHECK ("paymentMode" IN ('electronic', 'cash'));
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'CHK_trip_requests_payment_mode'
        ) THEN
          ALTER TABLE trip_requests
          ADD CONSTRAINT "CHK_trip_requests_payment_mode"
          CHECK ("paymentMode" IN ('electronic', 'cash'));
        END IF;
      END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE trip_requests
      DROP CONSTRAINT IF EXISTS "CHK_trip_requests_payment_mode";
    `);
    await queryRunner.query(`
      ALTER TABLE bookings
      DROP CONSTRAINT IF EXISTS "CHK_bookings_payment_mode";
    `);
    await queryRunner.query(`
      ALTER TABLE trip_requests DROP COLUMN IF EXISTS "paymentMode";
    `);
    await queryRunner.query(`
      ALTER TABLE bookings DROP COLUMN IF EXISTS "paymentMode";
    `);
  }
}
