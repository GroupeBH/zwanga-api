import { MigrationInterface, QueryRunner } from 'typeorm';

export class EnforceUserDriverRoleConsistency1780000028000 implements MigrationInterface {
  name = 'EnforceUserDriverRoleConsistency1780000028000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE users
      SET "isDriver" = false,
          "updatedAt" = NOW()
      WHERE role IN ('admin', 'super_admin')
        AND "isDriver" IS DISTINCT FROM false;
    `);

    await queryRunner.query(`
      UPDATE users AS u
      SET role = 'driver',
          "isDriver" = true,
          "updatedAt" = NOW()
      WHERE role = 'passenger'
        AND (
          "isDriver" IS TRUE
          OR EXISTS (
            SELECT 1
            FROM vehicles AS v
            WHERE v."ownerId" = u.id
              AND v."isActive" IS TRUE
          )
        );
    `);

    await queryRunner.query(`
      UPDATE users
      SET "isDriver" = true,
          "updatedAt" = NOW()
      WHERE role = 'driver'
        AND "isDriver" IS DISTINCT FROM true;
    `);

    await queryRunner.query(`
      UPDATE users
      SET "isDriver" = false,
          "updatedAt" = NOW()
      WHERE role = 'passenger'
        AND "isDriver" IS DISTINCT FROM false;
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conname = 'CHK_users_role_is_driver_consistency'
            AND conrelid = 'users'::regclass
        ) THEN
          ALTER TABLE users
          ADD CONSTRAINT "CHK_users_role_is_driver_consistency"
          CHECK (
            (
              role = 'driver'
              AND "isDriver" IS TRUE
            )
            OR (
              role IN ('passenger', 'admin', 'super_admin')
              AND "isDriver" IS FALSE
            )
          )
          NOT VALID;
        END IF;
      END
      $$;
    `);

    await queryRunner.query(`
      ALTER TABLE users
      VALIDATE CONSTRAINT "CHK_users_role_is_driver_consistency";
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE users
      DROP CONSTRAINT IF EXISTS "CHK_users_role_is_driver_consistency";
    `);
  }
}
