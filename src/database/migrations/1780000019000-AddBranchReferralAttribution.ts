import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddBranchReferralAttribution1780000019000 implements MigrationInterface {
  name = 'AddBranchReferralAttribution1780000019000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp";`);
    await queryRunner.query(`
      ALTER TABLE referral_profiles
        ADD COLUMN "linkToken" character varying(64),
        ADD COLUMN "branchLinkUrl" character varying(500),
        ADD COLUMN "branchLinkGeneratedAt" timestamp,
        ADD COLUMN "attributionProvider" character varying(30),
        ADD COLUMN "attributionLinkToken" character varying(64),
        ADD COLUMN "attributionReferringLink" character varying(500),
        ADD COLUMN "attributionCapturedAt" timestamp;
    `);
    await queryRunner.query(`
      UPDATE referral_profiles
      SET "linkToken" =
        replace(uuid_generate_v4()::text, '-', '') ||
        replace(uuid_generate_v4()::text, '-', '')
      WHERE "linkToken" IS NULL;
    `);
    await queryRunner.query(`
      ALTER TABLE referral_profiles
      ALTER COLUMN "linkToken" SET NOT NULL;
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "IDX_referral_profiles_link_token"
      ON referral_profiles ("linkToken");
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_referral_profiles_attribution_provider"
      ON referral_profiles ("attributionProvider")
      WHERE "attributionProvider" IS NOT NULL;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_referral_profiles_attribution_provider";`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_referral_profiles_link_token";`,
    );
    await queryRunner.query(`
      ALTER TABLE referral_profiles
        DROP COLUMN IF EXISTS "attributionCapturedAt",
        DROP COLUMN IF EXISTS "attributionReferringLink",
        DROP COLUMN IF EXISTS "attributionLinkToken",
        DROP COLUMN IF EXISTS "attributionProvider",
        DROP COLUMN IF EXISTS "branchLinkGeneratedAt",
        DROP COLUMN IF EXISTS "branchLinkUrl",
        DROP COLUMN IF EXISTS "linkToken";
    `);
  }
}
