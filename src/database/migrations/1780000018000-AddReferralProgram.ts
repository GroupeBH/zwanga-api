import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddReferralProgram1780000018000 implements MigrationInterface {
  name = 'AddReferralProgram1780000018000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp";`);

    await queryRunner.query(`
      CREATE TABLE referral_profiles (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "userId" uuid NOT NULL,
        code character varying(16) NOT NULL,
        "referredByUserId" uuid,
        "referredAt" timestamp,
        "qualifiedAt" timestamp,
        "rewardWindowEndsAt" timestamp,
        "createdAt" timestamp NOT NULL DEFAULT now(),
        "updatedAt" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_referral_profiles_user" UNIQUE ("userId"),
        CONSTRAINT "UQ_referral_profiles_code" UNIQUE (code),
        CONSTRAINT "FK_referral_profiles_user"
          FOREIGN KEY ("userId") REFERENCES users(id) ON DELETE CASCADE,
        CONSTRAINT "FK_referral_profiles_referrer"
          FOREIGN KEY ("referredByUserId") REFERENCES users(id) ON DELETE SET NULL,
        CONSTRAINT "CHK_referral_profiles_not_self"
          CHECK ("referredByUserId" IS NULL OR "referredByUserId" <> "userId")
      );
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_referral_profiles_referrer"
      ON referral_profiles ("referredByUserId");
    `);

    await queryRunner.query(`
      CREATE TABLE referral_accounts (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "userId" uuid NOT NULL,
        "pendingTokens" numeric(14, 2) NOT NULL DEFAULT 0,
        "availableTokens" numeric(14, 2) NOT NULL DEFAULT 0,
        "reservedTokens" numeric(14, 2) NOT NULL DEFAULT 0,
        "withdrawnTokens" numeric(14, 2) NOT NULL DEFAULT 0,
        currency character varying(8) NOT NULL DEFAULT 'PTS',
        "createdAt" timestamp NOT NULL DEFAULT now(),
        "updatedAt" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_referral_accounts_user" UNIQUE ("userId"),
        CONSTRAINT "FK_referral_accounts_user"
          FOREIGN KEY ("userId") REFERENCES users(id) ON DELETE CASCADE,
        CONSTRAINT "CHK_referral_account_reserved_non_negative"
          CHECK ("reservedTokens" >= 0),
        CONSTRAINT "CHK_referral_account_withdrawn_non_negative"
          CHECK ("withdrawnTokens" >= 0)
      );
    `);

    await queryRunner.query(`
      CREATE TABLE referral_rewards (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "referrerUserId" uuid NOT NULL,
        "referredUserId" uuid NOT NULL,
        "sourceType" character varying(40) NOT NULL,
        "sourceEntityId" uuid NOT NULL,
        "paymentTransactionId" uuid NOT NULL,
        "grossAmount" numeric(12, 2) NOT NULL,
        "sourceCurrency" character varying(8) NOT NULL,
        rate numeric(7, 6) NOT NULL,
        "rewardAmount" numeric(12, 2) NOT NULL,
        "rewardTokens" numeric(14, 2) NOT NULL,
        "sourceMoneyPerToken" numeric(12, 4) NOT NULL,
        status character varying(30) NOT NULL DEFAULT 'pending',
        "holdUntil" timestamp NOT NULL,
        "availableAt" timestamp,
        "reversedAt" timestamp,
        "reversalReason" character varying(500),
        "createdAt" timestamp NOT NULL DEFAULT now(),
        "updatedAt" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_referral_rewards_source" UNIQUE ("sourceType", "sourceEntityId"),
        CONSTRAINT "FK_referral_rewards_referrer"
          FOREIGN KEY ("referrerUserId") REFERENCES users(id) ON DELETE RESTRICT,
        CONSTRAINT "FK_referral_rewards_referred"
          FOREIGN KEY ("referredUserId") REFERENCES users(id) ON DELETE RESTRICT,
        CONSTRAINT "FK_referral_rewards_payment"
          FOREIGN KEY ("paymentTransactionId") REFERENCES payment_transactions(id) ON DELETE RESTRICT,
        CONSTRAINT "CHK_referral_rewards_source_type"
          CHECK ("sourceType" IN ('subscription_payment', 'booking_payment')),
        CONSTRAINT "CHK_referral_rewards_status"
          CHECK (status IN ('pending', 'available', 'reversed')),
        CONSTRAINT "CHK_referral_rewards_values"
          CHECK (
            "grossAmount" > 0 AND rate > 0 AND rate < 1
            AND "rewardAmount" > 0 AND "rewardTokens" > 0
            AND "sourceMoneyPerToken" > 0
          )
      );
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_referral_rewards_referrer_status"
      ON referral_rewards ("referrerUserId", status);
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_referral_rewards_referred_created"
      ON referral_rewards ("referredUserId", "createdAt");
    `);

    await queryRunner.query(`
      CREATE TABLE referral_withdrawals (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "userId" uuid NOT NULL,
        tokens numeric(14, 2) NOT NULL,
        amount numeric(14, 2) NOT NULL,
        currency character varying(8) NOT NULL DEFAULT 'CDF',
        "moneyPerToken" numeric(12, 4) NOT NULL,
        phone character varying(30) NOT NULL,
        status character varying(30) NOT NULL DEFAULT 'pending',
        "paymentTransactionId" uuid,
        "requestedAt" timestamp NOT NULL,
        "processedAt" timestamp,
        "failureReason" character varying(500),
        "createdAt" timestamp NOT NULL DEFAULT now(),
        "updatedAt" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "FK_referral_withdrawals_user"
          FOREIGN KEY ("userId") REFERENCES users(id) ON DELETE RESTRICT,
        CONSTRAINT "FK_referral_withdrawals_payment"
          FOREIGN KEY ("paymentTransactionId") REFERENCES payment_transactions(id) ON DELETE SET NULL,
        CONSTRAINT "CHK_referral_withdrawals_status"
          CHECK (status IN ('pending', 'initiated', 'succeeded', 'failed', 'cancelled')),
        CONSTRAINT "CHK_referral_withdrawals_values"
          CHECK (tokens > 0 AND amount > 0 AND "moneyPerToken" > 0)
      );
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_referral_withdrawals_user_status"
      ON referral_withdrawals ("userId", status);
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_referral_withdrawals_payment"
      ON referral_withdrawals ("paymentTransactionId");
    `);

    await queryRunner.query(`
      CREATE TABLE referral_ledger_entries (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "accountId" uuid NOT NULL,
        "userId" uuid NOT NULL,
        type character varying(40) NOT NULL,
        bucket character varying(20) NOT NULL,
        "amountTokens" numeric(14, 2) NOT NULL,
        "balanceAfter" numeric(14, 2) NOT NULL,
        "rewardId" uuid,
        "withdrawalId" uuid,
        "paymentTransactionId" uuid,
        description character varying(500) NOT NULL,
        "createdAt" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "FK_referral_ledger_account"
          FOREIGN KEY ("accountId") REFERENCES referral_accounts(id) ON DELETE RESTRICT,
        CONSTRAINT "FK_referral_ledger_reward"
          FOREIGN KEY ("rewardId") REFERENCES referral_rewards(id) ON DELETE SET NULL,
        CONSTRAINT "FK_referral_ledger_withdrawal"
          FOREIGN KEY ("withdrawalId") REFERENCES referral_withdrawals(id) ON DELETE SET NULL,
        CONSTRAINT "FK_referral_ledger_payment"
          FOREIGN KEY ("paymentTransactionId") REFERENCES payment_transactions(id) ON DELETE SET NULL,
        CONSTRAINT "CHK_referral_ledger_type"
          CHECK (type IN (
            'reward_pending', 'reward_released', 'reward_reversed',
            'withdrawal_reserved', 'withdrawal_succeeded', 'withdrawal_refunded'
          )),
        CONSTRAINT "CHK_referral_ledger_bucket"
          CHECK (bucket IN ('pending', 'available', 'reserved', 'withdrawn')),
        CONSTRAINT "CHK_referral_ledger_amount_non_zero"
          CHECK ("amountTokens" <> 0)
      );
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_referral_ledger_user_created"
      ON referral_ledger_entries ("userId", "createdAt");
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_referral_ledger_reward"
      ON referral_ledger_entries ("rewardId");
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_referral_ledger_withdrawal"
      ON referral_ledger_entries ("withdrawalId");
    `);

    await queryRunner.query(`
      INSERT INTO referral_profiles (
        "userId", code, "referredByUserId", "referredAt",
        "qualifiedAt", "rewardWindowEndsAt"
      )
      SELECT
        id,
        'ZW' || upper(substring(replace(id::text, '-', '') from 1 for 12)),
        NULL,
        NULL,
        NULL,
        NULL
      FROM users
      ON CONFLICT ("userId") DO NOTHING;
    `);
    await queryRunner.query(`
      INSERT INTO referral_accounts (
        "userId", "pendingTokens", "availableTokens",
        "reservedTokens", "withdrawnTokens", currency
      )
      SELECT id, 0, 0, 0, 0, 'PTS'
      FROM users
      ON CONFLICT ("userId") DO NOTHING;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM referral_rewards)
          OR EXISTS (SELECT 1 FROM referral_withdrawals)
          OR EXISTS (SELECT 1 FROM referral_ledger_entries)
          OR EXISTS (
            SELECT 1 FROM referral_accounts
            WHERE "pendingTokens" <> 0
              OR "availableTokens" <> 0
              OR "reservedTokens" <> 0
              OR "withdrawnTokens" <> 0
          )
        THEN
          RAISE EXCEPTION
            'Rollback refuse: des ecritures ou soldes de parrainage existent';
        END IF;
      END $$;
    `);
    await queryRunner.query(`DROP TABLE IF EXISTS referral_ledger_entries;`);
    await queryRunner.query(`DROP TABLE IF EXISTS referral_withdrawals;`);
    await queryRunner.query(`DROP TABLE IF EXISTS referral_rewards;`);
    await queryRunner.query(`DROP TABLE IF EXISTS referral_accounts;`);
    await queryRunner.query(`DROP TABLE IF EXISTS referral_profiles;`);
  }
}
