import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddVehicleTypeToTripRequests1780000015000 implements MigrationInterface {
  name = 'AddVehicleTypeToTripRequests1780000015000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "trip_requests"
      ADD COLUMN "vehicleType" "public"."vehicles_type_enum"
      NOT NULL DEFAULT 'car';
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_trip_requests_vehicle_type"
      ON "trip_requests" ("vehicleType");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS "IDX_trip_requests_vehicle_type";
    `);
    await queryRunner.query(`
      ALTER TABLE "trip_requests"
      DROP COLUMN "vehicleType";
    `);
  }
}
