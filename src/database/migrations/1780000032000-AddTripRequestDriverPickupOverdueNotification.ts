import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddTripRequestDriverPickupOverdueNotification1780000032000 implements MigrationInterface {
  name = 'AddTripRequestDriverPickupOverdueNotification1780000032000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "trip_requests"
      ADD COLUMN IF NOT EXISTS "driverPickupOverdueNotifiedAt" timestamptz
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_trip_requests_driver_pickup_overdue_pending"
      ON "trip_requests" ("departureDateMax")
      WHERE "status" = 'driver_selected'
        AND "driverPickupOverdueNotifiedAt" IS NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS "IDX_trip_requests_driver_pickup_overdue_pending"
    `);
    await queryRunner.query(`
      ALTER TABLE "trip_requests"
      DROP COLUMN IF EXISTS "driverPickupOverdueNotifiedAt"
    `);
  }
}
