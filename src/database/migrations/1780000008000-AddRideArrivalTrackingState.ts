import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddRideArrivalTrackingState1780000008000
  implements MigrationInterface
{
  name = 'AddRideArrivalTrackingState1780000008000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE bookings
      ADD COLUMN IF NOT EXISTS "passengerDestinationApproachNotifiedAt" timestamp;
    `);

    await queryRunner.query(`
      ALTER TABLE trips
      ADD COLUMN IF NOT EXISTS "destinationApproachNotifiedAt" timestamp,
      ADD COLUMN IF NOT EXISTS "destinationReachedAt" timestamp,
      ADD COLUMN IF NOT EXISTS "departureReminderNotified" boolean NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS "driverSafetyEmergencyContactIds" jsonb NOT NULL DEFAULT '[]'::jsonb;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE trips
      DROP COLUMN IF EXISTS "destinationReachedAt";
    `);

    await queryRunner.query(`
      ALTER TABLE trips
      DROP COLUMN IF EXISTS "destinationApproachNotifiedAt";
    `);

    await queryRunner.query(`
      ALTER TABLE bookings
      DROP COLUMN IF EXISTS "passengerDestinationApproachNotifiedAt";
    `);
  }
}
