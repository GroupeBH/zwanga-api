import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddAdminPasswordChangeRequired1780000026000
  implements MigrationInterface
{
  name = 'AddAdminPasswordChangeRequired1780000026000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS "passwordChangeRequired" boolean NOT NULL DEFAULT false;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE users
      DROP COLUMN IF EXISTS "passwordChangeRequired";
    `);
  }
}
