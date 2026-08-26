import { MigrationInterface, QueryRunner } from 'typeorm';

export class HardenTokenTripSettlements1780000021000 implements MigrationInterface {
  name = 'HardenTokenTripSettlements1780000021000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_wallet_ledger_entries_account_created"
      ON wallet_ledger_entries ("accountId", "createdAt" DESC);
    `);
    await queryRunner.query(`
      ALTER TABLE wallet_accounts
      ADD CONSTRAINT "CHK_wallet_accounts_balance_non_negative"
      CHECK (balance >= 0) NOT VALID;
    `);
    await queryRunner.query(`
      ALTER TABLE wallet_ledger_entries
      ADD CONSTRAINT "CHK_wallet_ledger_balance_after_non_negative"
      CHECK ("balanceAfter" >= 0) NOT VALID;
    `);
    await queryRunner.query(`
      ALTER TABLE driver_earnings
      ADD CONSTRAINT "CHK_driver_earnings_gross_positive"
      CHECK ("grossAmount" > 0) NOT VALID;
    `);
    await queryRunner.query(`
      ALTER TABLE driver_earnings
      ADD CONSTRAINT "CHK_driver_earnings_commission_rate_range"
      CHECK ("commissionRate" >= 0 AND "commissionRate" < 1) NOT VALID;
    `);
    await queryRunner.query(`
      ALTER TABLE driver_earnings
      ADD CONSTRAINT "CHK_driver_earnings_amounts_non_negative"
      CHECK ("commissionAmount" >= 0 AND "netAmount" >= 0) NOT VALID;
    `);
    await queryRunner.query(`
      ALTER TABLE driver_earnings
      ADD CONSTRAINT "CHK_driver_earnings_amount_conservation"
      CHECK ("grossAmount" = "commissionAmount" + "netAmount") NOT VALID;
    `);

    await queryRunner.query(`
      ALTER TABLE wallet_accounts
      VALIDATE CONSTRAINT "CHK_wallet_accounts_balance_non_negative";
    `);
    await queryRunner.query(`
      ALTER TABLE wallet_ledger_entries
      VALIDATE CONSTRAINT "CHK_wallet_ledger_balance_after_non_negative";
    `);
    await queryRunner.query(`
      ALTER TABLE driver_earnings
      VALIDATE CONSTRAINT "CHK_driver_earnings_gross_positive";
    `);
    await queryRunner.query(`
      ALTER TABLE driver_earnings
      VALIDATE CONSTRAINT "CHK_driver_earnings_commission_rate_range";
    `);
    await queryRunner.query(`
      ALTER TABLE driver_earnings
      VALIDATE CONSTRAINT "CHK_driver_earnings_amounts_non_negative";
    `);
    await queryRunner.query(`
      ALTER TABLE driver_earnings
      VALIDATE CONSTRAINT "CHK_driver_earnings_amount_conservation";
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE driver_earnings
      DROP CONSTRAINT IF EXISTS "CHK_driver_earnings_amount_conservation";
    `);
    await queryRunner.query(`
      ALTER TABLE driver_earnings
      DROP CONSTRAINT IF EXISTS "CHK_driver_earnings_amounts_non_negative";
    `);
    await queryRunner.query(`
      ALTER TABLE driver_earnings
      DROP CONSTRAINT IF EXISTS "CHK_driver_earnings_commission_rate_range";
    `);
    await queryRunner.query(`
      ALTER TABLE driver_earnings
      DROP CONSTRAINT IF EXISTS "CHK_driver_earnings_gross_positive";
    `);
    await queryRunner.query(`
      ALTER TABLE wallet_ledger_entries
      DROP CONSTRAINT IF EXISTS "CHK_wallet_ledger_balance_after_non_negative";
    `);
    await queryRunner.query(`
      ALTER TABLE wallet_accounts
      DROP CONSTRAINT IF EXISTS "CHK_wallet_accounts_balance_non_negative";
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS "IDX_wallet_ledger_entries_account_created";
    `);
  }
}
