import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddMarketerRole1780000073000 implements MigrationInterface {
  name = 'AddMarketerRole1780000073000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TYPE "public"."users_role_enum"
      ADD VALUE IF NOT EXISTS 'marketer';
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM users
          WHERE role::text = 'marketer'
        ) THEN
          RAISE EXCEPTION
            'Rollback refuse: des comptes marketer existent dans users';
        END IF;
      END $$;
    `);
    await queryRunner.query(`
      ALTER TABLE users
      ALTER COLUMN role DROP DEFAULT;
    `);
    await queryRunner.query(`
      ALTER TYPE "public"."users_role_enum"
      RENAME TO "users_role_enum_old";
    `);
    await queryRunner.query(`
      CREATE TYPE "public"."users_role_enum"
      AS ENUM ('driver', 'passenger', 'admin', 'super_admin');
    `);
    await queryRunner.query(`
      ALTER TABLE users
      ALTER COLUMN role TYPE "public"."users_role_enum"
      USING role::text::"public"."users_role_enum";
    `);
    await queryRunner.query(`
      ALTER TABLE users
      ALTER COLUMN role SET DEFAULT 'passenger'::"public"."users_role_enum";
    `);
    await queryRunner.query(`
      DROP TYPE "public"."users_role_enum_old";
    `);
  }
}
