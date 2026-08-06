import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddWalletTransfersAndSubscriptionPayments1780000012000
  implements MigrationInterface
{
  name = 'AddWalletTransfersAndSubscriptionPayments1780000012000';

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
        'transfer_out',
        'transfer_in'
      ));
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_wallet_ledger_subscription_payment"
      ON wallet_ledger_entries ("userId", type, "relatedEntityType", "relatedEntityId")
      WHERE "relatedEntityType" = 'subscription'
        AND type = 'subscription_payment';
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS "UQ_wallet_ledger_subscription_payment";
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
        'booking_fare_adjustment'
      ));
    `);
  }
}
