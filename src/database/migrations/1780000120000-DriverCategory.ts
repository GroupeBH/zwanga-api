import { MigrationInterface, QueryRunner } from 'typeorm';

/** Nullable addition: no implicit reclassification, backfill or dispatch change. */
export class DriverCategory1780000120000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" ADD COLUMN "driverCategory" text`);
    await queryRunner.query(`ALTER TABLE "users" ADD CONSTRAINT "CHK_users_driver_category"
      CHECK ("driverCategory" IS NULL OR "driverCategory" IN ('private', 'transport')) NOT VALID`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" DROP CONSTRAINT "CHK_users_driver_category"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "driverCategory"`);
  }
}
