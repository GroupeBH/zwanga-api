import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddReferralAttributionBonus1780000029000 implements MigrationInterface {
  name = 'AddReferralAttributionBonus1780000029000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE referral_rewards
      ALTER COLUMN "paymentTransactionId" DROP NOT NULL;
    `);

    await queryRunner.query(`
      ALTER TABLE referral_ledger_entries
      ADD COLUMN IF NOT EXISTS "sourceType" character varying(40);
    `);
    await queryRunner.query(`
      ALTER TABLE referral_ledger_entries
      ADD COLUMN IF NOT EXISTS "sourceEntityId" uuid;
    `);

    await queryRunner.query(`
      DROP INDEX IF EXISTS "UQ_referral_ledger_attribution_bonus";
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_referral_ledger_attribution_bonus"
      ON referral_ledger_entries ("userId", type, "sourceType", "sourceEntityId")
      WHERE type = 'attribution_bonus';
    `);

    await queryRunner.query(`
      ALTER TABLE referral_ledger_entries
      DROP CONSTRAINT IF EXISTS "CHK_referral_ledger_type";
    `);
    await queryRunner.query(`
      ALTER TABLE referral_ledger_entries
      ADD CONSTRAINT "CHK_referral_ledger_type"
      CHECK (type IN (
        'attribution_bonus',
        'reward_pending', 'reward_released', 'reward_reversed',
        'withdrawal_reserved', 'withdrawal_succeeded', 'withdrawal_refunded'
      )) NOT VALID;
    `);
    await queryRunner.query(`
      ALTER TABLE referral_ledger_entries
      VALIDATE CONSTRAINT "CHK_referral_ledger_type";
    `);

    await queryRunner.query(`
      ALTER TABLE referral_ledger_entries
      DROP CONSTRAINT IF EXISTS "CHK_referral_ledger_attribution_source";
    `);
    await queryRunner.query(`
      ALTER TABLE referral_ledger_entries
      ADD CONSTRAINT "CHK_referral_ledger_attribution_source"
      CHECK (
        type <> 'attribution_bonus'
        OR (
          "sourceType" = 'referral_attribution'
          AND "sourceEntityId" IS NOT NULL
          AND "rewardId" IS NULL
          AND "withdrawalId" IS NULL
          AND "paymentTransactionId" IS NULL
        )
      ) NOT VALID;
    `);
    await queryRunner.query(`
      ALTER TABLE referral_ledger_entries
      VALIDATE CONSTRAINT "CHK_referral_ledger_attribution_source";
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM referral_ledger_entries
          WHERE type = 'attribution_bonus'
        ) THEN
          RAISE EXCEPTION 'Rollback refuse: des bonus de rattachement existent dans referral_ledger_entries';
        END IF;

        IF EXISTS (
          SELECT 1 FROM referral_rewards
          WHERE "paymentTransactionId" IS NULL
        ) THEN
          RAISE EXCEPTION 'Rollback refuse: des commissions sans transaction FlexPay existent dans referral_rewards';
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      ALTER TABLE referral_ledger_entries
      DROP CONSTRAINT IF EXISTS "CHK_referral_ledger_attribution_source";
    `);
    await queryRunner.query(`
      ALTER TABLE referral_ledger_entries
      DROP CONSTRAINT IF EXISTS "CHK_referral_ledger_type";
    `);
    await queryRunner.query(`
      ALTER TABLE referral_ledger_entries
      ADD CONSTRAINT "CHK_referral_ledger_type"
      CHECK (type IN (
        'reward_pending', 'reward_released', 'reward_reversed',
        'withdrawal_reserved', 'withdrawal_succeeded', 'withdrawal_refunded'
      )) NOT VALID;
    `);
    await queryRunner.query(`
      ALTER TABLE referral_ledger_entries
      VALIDATE CONSTRAINT "CHK_referral_ledger_type";
    `);

    await queryRunner.query(`
      DROP INDEX IF EXISTS "UQ_referral_ledger_attribution_bonus";
    `);
    await queryRunner.query(`
      ALTER TABLE referral_ledger_entries
      DROP COLUMN IF EXISTS "sourceEntityId";
    `);
    await queryRunner.query(`
      ALTER TABLE referral_ledger_entries
      DROP COLUMN IF EXISTS "sourceType";
    `);
    await queryRunner.query(`
      ALTER TABLE referral_rewards
      ALTER COLUMN "paymentTransactionId" SET NOT NULL;
    `);
  }
}
