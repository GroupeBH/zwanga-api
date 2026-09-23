import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddGenderToUsers1780000013000 implements MigrationInterface {
  name = 'AddGenderToUsers1780000013000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "public"."users_gender_enum"
      AS ENUM ('male', 'female', 'other', 'prefer_not_to_say');
    `);
    await queryRunner.query(`
      ALTER TABLE "users"
      ADD COLUMN "gender" "public"."users_gender_enum";
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "users"
      DROP COLUMN "gender";
    `);
    await queryRunner.query(`
      DROP TYPE "public"."users_gender_enum";
    `);
  }
}
