import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddBookingNoShowState1780000017000 implements MigrationInterface {
  name = 'AddBookingNoShowState1780000017000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TYPE "public"."bookings_status_enum"
      ADD VALUE IF NOT EXISTS 'no_show';
    `);
    await queryRunner.query(`
      ALTER TYPE "public"."bookings_status_enum"
      ADD VALUE IF NOT EXISTS 'boarding_uncertain';
    `);
    await queryRunner.query(`
      ALTER TABLE "bookings"
      ADD COLUMN "noShowDetectedAt" TIMESTAMP,
      ADD COLUMN "noShowReason" VARCHAR(80),
      ADD COLUMN "noShowDriverDistanceMeters" INTEGER,
      ADD COLUMN "boardingUncertainDetectedAt" TIMESTAMP,
      ADD COLUMN "boardingUncertainReason" VARCHAR(80),
      ADD COLUMN "boardingUncertainDriverDistanceMeters" INTEGER,
      ADD COLUMN "pickupDetectionMethod" VARCHAR(50),
      ADD COLUMN "dropoffDetectionMethod" VARCHAR(50);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "bookings"
      SET "status" = 'cancelled',
          "cancelledAt" = COALESCE("cancelledAt", "noShowDetectedAt")
      WHERE "status" = 'no_show';
    `);
    await queryRunner.query(`
      UPDATE "bookings"
      SET "status" = 'cancelled',
          "cancelledAt" = COALESCE("cancelledAt", "boardingUncertainDetectedAt")
      WHERE "status" = 'boarding_uncertain';
    `);
    await queryRunner.query(`
      ALTER TABLE "bookings"
      DROP COLUMN "dropoffDetectionMethod",
      DROP COLUMN "pickupDetectionMethod",
      DROP COLUMN "boardingUncertainDriverDistanceMeters",
      DROP COLUMN "boardingUncertainReason",
      DROP COLUMN "boardingUncertainDetectedAt",
      DROP COLUMN "noShowDriverDistanceMeters",
      DROP COLUMN "noShowReason",
      DROP COLUMN "noShowDetectedAt";
    `);
    await queryRunner.query(`
      ALTER TYPE "public"."bookings_status_enum" RENAME TO "bookings_status_enum_old";
      CREATE TYPE "public"."bookings_status_enum" AS ENUM (
        'pending', 'accepted', 'rejected', 'cancelled', 'completed', 'expired'
      );
      ALTER TABLE "bookings"
      ALTER COLUMN "status" DROP DEFAULT,
      ALTER COLUMN "status" TYPE "public"."bookings_status_enum"
      USING "status"::text::"public"."bookings_status_enum",
      ALTER COLUMN "status" SET DEFAULT 'pending';
      DROP TYPE "public"."bookings_status_enum_old";
    `);
  }
}
