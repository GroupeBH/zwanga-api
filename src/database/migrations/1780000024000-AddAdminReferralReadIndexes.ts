import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddAdminReferralReadIndexes1780000024000 implements MigrationInterface {
  name = 'AddAdminReferralReadIndexes1780000024000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_referral_accounts_admin_updated"
      ON referral_accounts ("updatedAt" DESC, id DESC);
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_referral_rewards_admin_created"
      ON referral_rewards ("createdAt" DESC, id DESC);
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_referral_rewards_admin_status_created"
      ON referral_rewards (status, "createdAt" DESC, id DESC);
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_referral_withdrawals_admin_requested"
      ON referral_withdrawals ("requestedAt" DESC, id DESC);
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_referral_withdrawals_admin_status_requested"
      ON referral_withdrawals (status, "requestedAt" DESC, id DESC);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS "IDX_referral_withdrawals_admin_status_requested";
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS "IDX_referral_withdrawals_admin_requested";
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS "IDX_referral_rewards_admin_status_created";
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS "IDX_referral_rewards_admin_created";
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS "IDX_referral_accounts_admin_updated";
    `);
  }
}
