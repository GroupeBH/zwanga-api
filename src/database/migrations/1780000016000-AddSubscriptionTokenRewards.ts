import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddSubscriptionTokenRewards1780000016000
  implements MigrationInterface
{
  name = 'AddSubscriptionTokenRewards1780000016000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE wallet_ledger_entries
      DROP CONSTRAINT IF EXISTS "CHK_wallet_ledger_type";
    `);
    await queryRunner.query(`
      ALTER TABLE wallet_ledger_entries
      ADD CONSTRAINT "CHK_wallet_ledger_type"
      CHECK (type IN (
        'top_up',
        'loyalty_reward',
        'booking_payment',
        'booking_refund',
        'booking_fare_adjustment',
        'subscription_payment',
        'subscription_reward',
        'transfer_out',
        'transfer_in'
      ));
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_wallet_ledger_subscription_reward"
      ON wallet_ledger_entries ("userId", type, "relatedEntityType", "relatedEntityId")
      WHERE "relatedEntityType" = 'subscription'
        AND type = 'subscription_reward';
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM wallet_ledger_entries
          WHERE type = 'subscription_reward'
        ) THEN
          RAISE EXCEPTION
            'Rollback refuse: des recompenses d abonnement existent dans wallet_ledger_entries';
        END IF;
      END $$;
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS "UQ_wallet_ledger_subscription_reward";
    `);
    await queryRunner.query(`
      ALTER TABLE wallet_ledger_entries
      DROP CONSTRAINT IF EXISTS "CHK_wallet_ledger_type";
    `);
    await queryRunner.query(`
      ALTER TABLE wallet_ledger_entries
      ADD CONSTRAINT "CHK_wallet_ledger_type"
      CHECK (type IN (
        'top_up',
        'loyalty_reward',
        'booking_payment',
        'booking_refund',
        'booking_fare_adjustment',
        'subscription_payment',
        'transfer_out',
        'transfer_in'
      ));
    `);
  }
}
