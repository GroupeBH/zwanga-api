import { MigrationInterface, QueryRunner } from 'typeorm';

export class RepairDriverPickupArrivedAt1780000009000
  implements MigrationInterface
{
  name = 'RepairDriverPickupArrivedAt1780000009000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE bookings
      ADD COLUMN IF NOT EXISTS "driverPickupArrivedAt" timestamp;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE bookings
      DROP COLUMN IF EXISTS "driverPickupArrivedAt";
    `);
  }
}
