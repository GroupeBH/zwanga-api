import { MigrationInterface, QueryRunner } from 'typeorm';
import { cashAllTokenOriginsSql } from './sql/cash-all-token-origins';

export class CashCommissionAllTokenOrigins1780000055000 implements MigrationInterface {
  name = 'CashCommissionAllTokenOrigins1780000055000';

  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`SET LOCAL lock_timeout = '5s'`);
    await runner.query(`
      ALTER TABLE wallet_accounts DROP CONSTRAINT "CHK_wallet_cash_reserve";
      ALTER TABLE wallet_accounts ADD CONSTRAINT "CHK_wallet_cash_reserve"
        CHECK ("reservedCashCommissionBalance" >= 0 AND "reservedCashCommissionBalance" <= balance);
      ALTER TABLE cash_commissions ADD COLUMN "chargedWithdrawableTokens" numeric(12,2) NOT NULL DEFAULT 0;
      -- Prior migrations only debited purchased tokens. Do not reprice historical charges.
      UPDATE cash_commissions SET "chargedWithdrawableTokens" = "chargedTokens";
      ALTER TABLE cash_commissions ADD CONSTRAINT "CHK_cash_charged_origin"
        CHECK ("chargedWithdrawableTokens" >= 0 AND "chargedWithdrawableTokens" <= "chargedTokens");
    `);
    await runner.query(cashAllTokenOriginsSql);
    // Existing debts may now be covered by rewards already in the wallet.
    await runner.query(`DO $$ DECLARE c cash_commissions%ROWTYPE; BEGIN
      FOR c IN SELECT * FROM cash_commissions WHERE "debtTokens" > 0 ORDER BY "driverId", "createdAt", "bookingId" LOOP
        PERFORM zwanga_cash_sync(c."bookingId",c."driverId",c."tripId",c."baseAmount",c."moneyPerToken",c.state,false);
      END LOOP;
    END $$`);
  }

  down(): Promise<void> {
    return Promise.reject(new Error('Cash commissions contain mixed-origin financial history; use a reconciled forward migration.'));
  }
}
