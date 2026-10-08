import { MigrationInterface, QueryRunner } from 'typeorm';
import { cashCreditSyncSql, cashCreditGuardsSql } from './sql/cash-commission-credit';

/** Forward-only: historical rates and financial movements must not be repriced. */
export class CashCommissionCredit1780000053000 implements MigrationInterface {
  name = 'CashCommissionCredit1780000053000';

  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`SET LOCAL lock_timeout = '5s'`);
    await runner.query(`
      ALTER TABLE bookings ALTER COLUMN "cashCommissionPolicyVersion" SET DEFAULT 2;
      UPDATE bookings SET "cashCommissionPolicyVersion" = 2 WHERE status = 'pending' AND "cashCommissionPolicyVersion" = 1;
      ALTER TABLE trip_requests ADD COLUMN "cashCommissionPolicyVersion" smallint NOT NULL DEFAULT 2;
      UPDATE trip_requests SET "cashCommissionPolicyVersion" = 1 WHERE status = 'driver_selected';
      ALTER TABLE cash_commissions ADD COLUMN "creditLimitTokens" numeric(12,2) NOT NULL DEFAULT 0 CHECK ("creditLimitTokens" IN (0,25));
      ALTER TABLE cash_commissions ADD COLUMN "requestId" uuid UNIQUE;
    `);
    await runner.query(cashCreditSyncSql);
    await runner.query(cashCreditGuardsSql);
  }

  down(): Promise<void> {
    return Promise.reject(new Error('Cash credit has financial history; reconcile and use a forward migration.'));
  }
}
