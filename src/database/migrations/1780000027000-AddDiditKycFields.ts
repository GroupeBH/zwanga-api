import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddDiditKycFields1780000027000 implements MigrationInterface {
  name = 'AddDiditKycFields1780000027000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_type
          WHERE typname = 'kyc_documents_provider_enum'
        ) THEN
          CREATE TYPE kyc_documents_provider_enum AS ENUM ('legacy', 'didit');
        END IF;
      END
      $$;
    `);

    await queryRunner.query(`
      ALTER TABLE kyc_documents
      ADD COLUMN IF NOT EXISTS "provider" kyc_documents_provider_enum NOT NULL DEFAULT 'legacy',
      ADD COLUMN IF NOT EXISTS "diditSessionId" character varying,
      ADD COLUMN IF NOT EXISTS "diditSessionNumber" integer,
      ADD COLUMN IF NOT EXISTS "diditWorkflowId" character varying,
      ADD COLUMN IF NOT EXISTS "diditVendorData" character varying,
      ADD COLUMN IF NOT EXISTS "diditSessionStatus" character varying,
      ADD COLUMN IF NOT EXISTS "diditLastSyncedAt" timestamp,
      ADD COLUMN IF NOT EXISTS "providerMetadata" jsonb;
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_kyc_documents_didit_session_id"
      ON kyc_documents ("diditSessionId")
      WHERE "diditSessionId" IS NOT NULL;
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_kyc_documents_user_provider"
      ON kyc_documents ("userId", "provider");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS "IDX_kyc_documents_user_provider";
    `);

    await queryRunner.query(`
      DROP INDEX IF EXISTS "IDX_kyc_documents_didit_session_id";
    `);

    await queryRunner.query(`
      ALTER TABLE kyc_documents
      DROP COLUMN IF EXISTS "providerMetadata",
      DROP COLUMN IF EXISTS "diditLastSyncedAt",
      DROP COLUMN IF EXISTS "diditSessionStatus",
      DROP COLUMN IF EXISTS "diditVendorData",
      DROP COLUMN IF EXISTS "diditWorkflowId",
      DROP COLUMN IF EXISTS "diditSessionNumber",
      DROP COLUMN IF EXISTS "diditSessionId",
      DROP COLUMN IF EXISTS "provider";
    `);

    await queryRunner.query(`
      DROP TYPE IF EXISTS kyc_documents_provider_enum;
    `);
  }
}
