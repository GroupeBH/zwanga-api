import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddVehicleTypes1780000014000 implements MigrationInterface {
  name = 'AddVehicleTypes1780000014000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "public"."vehicles_type_enum"
      AS ENUM ('car', 'motorcycle_2_wheels', 'motorcycle_3_wheels');
    `);
    await queryRunner.query(`
      ALTER TABLE "vehicles"
      ADD COLUMN "type" "public"."vehicles_type_enum"
      NOT NULL DEFAULT 'car';
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "vehicles"
      DROP COLUMN "type";
    `);
    await queryRunner.query(`
      DROP TYPE "public"."vehicles_type_enum";
    `);
  }
}
