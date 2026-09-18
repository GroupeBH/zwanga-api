import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddPurchasedTokenWithdrawals1780000038000 implements MigrationInterface {
  name = 'AddPurchasedTokenWithdrawals1780000038000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    // Deploy with wallet writes paused; old binaries do not track allocations.
    await queryRunner.query(
      `LOCK TABLE wallet_accounts, wallet_ledger_entries IN ACCESS EXCLUSIVE MODE`,
    );
    await queryRunner.query(`ALTER TABLE wallet_accounts
      ADD COLUMN "withdrawableBalance" numeric(12,2) NOT NULL DEFAULT 0,
      ADD COLUMN "reservedWithdrawalBalance" numeric(12,2) NOT NULL DEFAULT 0,
      ADD COLUMN "withdrawalsBlocked" boolean NOT NULL DEFAULT false`);
    await queryRunner.query(`ALTER TABLE wallet_ledger_entries
      ADD COLUMN "withdrawableAmount" numeric(12,2) NULL`);
    // A deliberately conservative lower bound. Historical debits had no recorded
    // source: subtract ALL of them from verified purchases, not from rewards.
    // Unproven transfers, refunds and admin credits never become cash automatically.
    // Incomplete ledgers get zero; total balances and historical entries stay intact.
    await queryRunner.query(`WITH history AS (
      SELECT e."accountId", SUM(e.amount) AS total,
        SUM(CASE WHEN e.amount < 0 THEN e.amount ELSE 0 END) AS debits,
        SUM(CASE WHEN e.type = 'top_up' AND e.amount > 0
          AND p.status = 'succeeded' AND p.purpose = 'wallet_top_up'
          AND p."userId" = e."userId" AND p."relatedEntityType" = 'wallet_top_up'
          AND p."relatedEntityId" = e."userId"::text
          AND COALESCE(p."rawCheckResponse"->>'code', p."rawCheckResponse"->>'Code') = '0'
          AND COALESCE(proof.tx->>'status', proof.tx->>'Status', proof.tx->>'code', proof.tx->>'Code') = '0'
          AND proof.tx->>'orderNumber' = p."orderNumber"
          AND proof.tx->>'reference' IN (p.reference, p."orderNumber")
          AND UPPER(proof.tx->>'currency') = p.currency
          AND CASE WHEN proof.tx->>'amount' ~ '^[0-9]+([.][0-9]+)?$'
            THEN (proof.tx->>'amount')::numeric = p.amount ELSE false END
          AND NOT EXISTS (SELECT 1 FROM wallet_ledger_entries duplicate
            WHERE duplicate."paymentTransactionId" = e."paymentTransactionId"
              AND duplicate.type = 'top_up' AND duplicate.id <> e.id)
          THEN e.amount ELSE 0 END) AS purchases
      FROM wallet_ledger_entries e LEFT JOIN payment_transactions p ON p.id = e."paymentTransactionId"
      LEFT JOIN LATERAL (SELECT COALESCE(p."rawCheckResponse"->'transaction', p."rawCheckResponse"->'Transaction') AS tx) proof ON true
      GROUP BY e."accountId"
    ) UPDATE wallet_accounts a SET "withdrawableBalance" =
      CASE WHEN h.total = a.balance THEN LEAST(a.balance, GREATEST(0, h.purchases + h.debits)) ELSE 0 END
      FROM history h WHERE a.id = h."accountId"`);
    await queryRunner.query(`ALTER TABLE wallet_accounts ADD CONSTRAINT "CHK_wallet_accounts_withdrawable"
      CHECK ("withdrawableBalance" >= 0 AND "withdrawableBalance" <= balance AND "reservedWithdrawalBalance" >= 0)`);
    await queryRunner.query(`ALTER TABLE wallet_ledger_entries ADD CONSTRAINT "CHK_wallet_ledger_withdrawable_amount"
      CHECK ("withdrawableAmount" IS NULL OR (ABS("withdrawableAmount") <= ABS(amount) AND "withdrawableAmount" * amount >= 0))`);
    await queryRunner.query(
      `ALTER TABLE wallet_ledger_entries DROP CONSTRAINT "CHK_wallet_ledger_type"`,
    );
    await queryRunner.query(`ALTER TABLE wallet_ledger_entries ADD CONSTRAINT "CHK_wallet_ledger_type"
      CHECK (type IN ('top_up', 'loyalty_reward', 'booking_payment', 'booking_refund',
        'booking_fare_adjustment', 'subscription_payment', 'subscription_reward', 'transfer_out',
        'transfer_in', 'admin_adjustment', 'withdrawal', 'withdrawal_refund'))`);
    await queryRunner.query(`CREATE TABLE wallet_withdrawals (
      id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), "userId" uuid NOT NULL REFERENCES users(id),
      "idempotencyKey" uuid NOT NULL, tokens numeric(12,2) NOT NULL,
      amount numeric(10,2) NOT NULL, "moneyPerToken" numeric(12,4) NOT NULL,
      currency varchar(8) NOT NULL, phone varchar(30) NOT NULL,
      status varchar(40) NOT NULL DEFAULT 'pending',
      "paymentTransactionId" uuid NULL REFERENCES payment_transactions(id),
      "releasedAt" timestamp NULL, "processedAt" timestamp NULL,
      "createdAt" timestamp NOT NULL DEFAULT now(), "updatedAt" timestamp NOT NULL DEFAULT now(),
      CONSTRAINT "CHK_wallet_withdrawal_positive" CHECK (tokens > 0 AND amount > 0 AND "moneyPerToken" > 0),
      CONSTRAINT "CHK_wallet_withdrawal_status" CHECK (status IN ('pending', 'initiated', 'succeeded', 'failed', 'cancelled', 'review'))
    )`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_wallet_withdrawals_request" ON wallet_withdrawals ("userId", "idempotencyKey")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_wallet_withdrawals_user_created" ON wallet_withdrawals ("userId", "createdAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_wallet_withdrawals_status" ON wallet_withdrawals (status)`,
    );
    await queryRunner.query(`CREATE UNIQUE INDEX "UQ_wallet_ledger_withdrawal" ON wallet_ledger_entries ("relatedEntityId", type)
      WHERE "relatedEntityType" = 'wallet_withdrawal' AND type IN ('withdrawal', 'withdrawal_refund')`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    // Erasing provenance after use would silently turn purchased tokens into rewards.
    await queryRunner.query(`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM wallet_withdrawals) OR EXISTS (
        SELECT 1 FROM wallet_ledger_entries WHERE "withdrawableAmount" IS NOT NULL
      ) THEN RAISE EXCEPTION 'Rollback refused: wallet provenance or withdrawals already used'; END IF;
    END $$`);
    await queryRunner.query(`DROP TABLE wallet_withdrawals`);
    await queryRunner.query(`DROP INDEX "UQ_wallet_ledger_withdrawal"`);
    await queryRunner.query(`ALTER TABLE wallet_ledger_entries DROP CONSTRAINT "CHK_wallet_ledger_type",
      DROP CONSTRAINT "CHK_wallet_ledger_withdrawable_amount", DROP COLUMN "withdrawableAmount"`);
    await queryRunner.query(`ALTER TABLE wallet_ledger_entries ADD CONSTRAINT "CHK_wallet_ledger_type"
      CHECK (type IN ('top_up', 'loyalty_reward', 'booking_payment', 'booking_refund',
        'booking_fare_adjustment', 'subscription_payment', 'subscription_reward', 'transfer_out', 'transfer_in', 'admin_adjustment'))`);
    await queryRunner.query(`ALTER TABLE wallet_accounts DROP CONSTRAINT "CHK_wallet_accounts_withdrawable",
      DROP COLUMN "withdrawableBalance", DROP COLUMN "reservedWithdrawalBalance", DROP COLUMN "withdrawalsBlocked"`);
  }
}
