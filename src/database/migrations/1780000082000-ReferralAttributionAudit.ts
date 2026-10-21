import { MigrationInterface, QueryRunner } from 'typeorm';

/** Keep the admin audit without creating a financial signup-bonus entry. */
export class ReferralAttributionAudit1780000082000 implements MigrationInterface {
  name = 'ReferralAttributionAudit1780000082000';

  async up(runner: QueryRunner): Promise<void> {
    if (!runner.isTransactionActive)
      throw new Error('Referral attribution audit migration requires a transaction');
    await runner.query("SET LOCAL lock_timeout = '5s'");
    await runner.query("SET LOCAL statement_timeout = '15s'");
    await runner.query(`ALTER TABLE referral_profiles
      ADD COLUMN "attributionAdminId" uuid,
      ADD COLUMN "attributionAdminReason" varchar(300)`);
    // No balance/ledger rewrite; past admin reasons stay in their original ledger.
  }

  async down(runner: QueryRunner): Promise<void> {
    if (!runner.isTransactionActive)
      throw new Error('Referral attribution audit rollback requires a transaction');
    await runner.query("SET LOCAL lock_timeout = '5s'");
    await runner.query("SET LOCAL statement_timeout = '15s'");
    // Exclude writes between the audit-preservation check and the schema change.
    await runner.query('LOCK TABLE referral_profiles IN ACCESS EXCLUSIVE MODE');
    const [row] = await runner.query(`SELECT EXISTS (
      SELECT 1 FROM referral_profiles
      WHERE "attributionAdminId" IS NOT NULL OR "attributionAdminReason" IS NOT NULL
    ) AS used`);
    if (row?.used)
      throw new Error('Use a forward migration: referral attribution audits must be preserved');
    await runner.query(`ALTER TABLE referral_profiles
      DROP COLUMN "attributionAdminReason",
      DROP COLUMN "attributionAdminId"`);
  }
}
