import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddAppleIdToUsers1780000002000 implements MigrationInterface {
  name = 'AddAppleIdToUsers1780000002000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'users'
            AND column_name = 'appleId'
        ) THEN
          ALTER TABLE users ADD COLUMN "appleId" character varying;
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conname = 'UQ_users_appleId'
        ) THEN
          ALTER TABLE users ADD CONSTRAINT "UQ_users_appleId" UNIQUE ("appleId");
        END IF;
      END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE users DROP CONSTRAINT IF EXISTS "UQ_users_appleId";
    `);

    await queryRunner.query(`
      ALTER TABLE users DROP COLUMN IF EXISTS "appleId";
    `);
  }
}
