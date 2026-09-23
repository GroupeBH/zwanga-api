import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Prepared migration only; schedule deployment on large tables (regular index creation locks writes). */
export class AddFinancialHistoryIndexes1780000040000 implements MigrationInterface {
  name = 'AddFinancialHistoryIndexes1780000040000';
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('CREATE INDEX IF NOT EXISTS "IDX_payments_user_history" ON payment_transactions ("userId", "createdAt" DESC, id DESC)');
    await queryRunner.query('CREATE INDEX IF NOT EXISTS "IDX_earnings_driver_history" ON driver_earnings ("driverId", (COALESCE("availableAt", "createdAt")) DESC, id DESC)');
    await queryRunner.query('CREATE INDEX IF NOT EXISTS "IDX_payouts_driver_history" ON driver_payouts ("driverId", "createdAt" DESC, id DESC)');
  }
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX IF EXISTS "IDX_payouts_driver_history"');
    await queryRunner.query('DROP INDEX IF EXISTS "IDX_earnings_driver_history"');
    await queryRunner.query('DROP INDEX IF EXISTS "IDX_payments_user_history"');
  }
}
