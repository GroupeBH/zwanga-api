import { MigrationInterface, QueryRunner } from 'typeorm';

/** New quotes only. Never reprice a booked ride, payout or top-up in flight. */
export class TokenValue10Cdf1780000080000 implements MigrationInterface {
  name = 'TokenValue10Cdf1780000080000';

  async up(runner: QueryRunner): Promise<void> {
    if (!runner.isTransactionActive)
      throw new Error('Token denomination migration requires a transaction');
    await runner.query("SET LOCAL lock_timeout = '5s'");
    await runner.query("SET LOCAL statement_timeout = '15s'");
    await runner.query(
      'ALTER TABLE bookings ALTER COLUMN "cashCommissionTokenValue" SET DEFAULT 10',
    );
  }

  async down(runner: QueryRunner): Promise<void> {
    if (!runner.isTransactionActive)
      throw new Error('Token denomination rollback requires a transaction');
    await runner.query("SET LOCAL lock_timeout = '5s'");
    await runner.query("SET LOCAL statement_timeout = '15s'");
    // Revert only the insertion default, never any already recorded 10-FC quote.
    await runner.query(
      'ALTER TABLE bookings ALTER COLUMN "cashCommissionTokenValue" SET DEFAULT 25',
    );
  }
}
