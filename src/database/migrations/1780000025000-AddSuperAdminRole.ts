import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddSuperAdminRole1780000025000 implements MigrationInterface {
  name = 'AddSuperAdminRole1780000025000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TYPE "public"."users_role_enum"
      ADD VALUE IF NOT EXISTS 'super_admin';
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM users
          WHERE role::text = 'super_admin'
        ) THEN
          RAISE EXCEPTION
            'Rollback refuse: des comptes super_admin existent dans users';
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
      AS ENUM ('driver', 'passenger', 'admin');
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
