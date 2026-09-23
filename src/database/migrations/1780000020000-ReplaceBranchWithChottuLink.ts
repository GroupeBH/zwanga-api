import { MigrationInterface, QueryRunner } from 'typeorm';

export class ReplaceBranchWithChottuLink1780000020000 implements MigrationInterface {
  name = 'ReplaceBranchWithChottuLink1780000020000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE referral_profiles
        RENAME COLUMN "branchLinkUrl" TO "shareLinkUrl";
    `);
    await queryRunner.query(`
      ALTER TABLE referral_profiles
        RENAME COLUMN "branchLinkGeneratedAt" TO "shareLinkGeneratedAt";
    `);
    await queryRunner.query(`
      UPDATE referral_profiles
      SET
        "shareLinkUrl" = NULL,
        "shareLinkGeneratedAt" = NULL
      WHERE "shareLinkUrl" IS NOT NULL;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE referral_profiles
        RENAME COLUMN "shareLinkGeneratedAt" TO "branchLinkGeneratedAt";
    `);
    await queryRunner.query(`
      ALTER TABLE referral_profiles
        RENAME COLUMN "shareLinkUrl" TO "branchLinkUrl";
    `);
  }
}
