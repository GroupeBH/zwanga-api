import { MigrationInterface, QueryRunner } from 'typeorm';

/** Additive quote storage only: no balance, historical quote or ledger rewrite. */
export class TokenValue25Cdf1780000070000 implements MigrationInterface {
  name = 'TokenValue25Cdf1780000070000';

  async up(runner: QueryRunner): Promise<void> {
    if (!runner.isTransactionActive)
      throw new Error('Token denomination migration requires a transaction');
    await runner.query("SET LOCAL lock_timeout = '5s'");
    await runner.query("SET LOCAL statement_timeout = '15s'");
    await runner.query(`ALTER TABLE payment_transactions
      ADD COLUMN "tokenQuantity" numeric(12,2),
      ADD CONSTRAINT "CHK_payment_token_quantity" CHECK (
        "tokenQuantity" IS NULL OR ("tokenQuantity" > 0 AND purpose = 'wallet_top_up')
      ) NOT VALID`);
    // Existing bookings retain their immutable quoted value (usually 100).
    await runner.query(
      `ALTER TABLE bookings ALTER COLUMN "cashCommissionTokenValue" SET DEFAULT 25`,
    );
  }

  down(): Promise<void> {
    return Promise.reject(
      new Error(
        'Use a forward migration; do not discard historical token purchase quotes.',
      ),
    );
  }
}
