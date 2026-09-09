import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddPassengerKycRequirements1780000033000 implements MigrationInterface {
  name = 'AddPassengerKycRequirements1780000033000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "trips"
      ADD COLUMN IF NOT EXISTS "requiresPassengerKyc" boolean NOT NULL DEFAULT false
    `);

    await queryRunner.query(`
      ALTER TABLE "recurring_trip_templates"
      ADD COLUMN IF NOT EXISTS "requiresPassengerKyc" boolean NOT NULL DEFAULT false
    `);

    await queryRunner.query(`
      ALTER TABLE "driver_offers"
      ADD COLUMN IF NOT EXISTS "requiresPassengerKyc" boolean NOT NULL DEFAULT false
    `);

    await queryRunner.query(`
      ALTER TABLE "trip_requests"
      ADD COLUMN IF NOT EXISTS "selectedDriverRequiresPassengerKyc" boolean NOT NULL DEFAULT false
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_kyc_documents_user_approved"
      ON "kyc_documents" ("userId")
      WHERE "status" = 'approved'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS "IDX_kyc_documents_user_approved"
    `);

    await queryRunner.query(`
      ALTER TABLE "trip_requests"
      DROP COLUMN IF EXISTS "selectedDriverRequiresPassengerKyc"
    `);

    await queryRunner.query(`
      ALTER TABLE "driver_offers"
      DROP COLUMN IF EXISTS "requiresPassengerKyc"
    `);

    await queryRunner.query(`
      ALTER TABLE "recurring_trip_templates"
      DROP COLUMN IF EXISTS "requiresPassengerKyc"
    `);

    await queryRunner.query(`
      ALTER TABLE "trips"
      DROP COLUMN IF EXISTS "requiresPassengerKyc"
    `);
  }
}
