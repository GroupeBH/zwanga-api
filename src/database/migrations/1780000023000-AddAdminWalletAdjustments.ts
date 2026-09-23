import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddAdminWalletAdjustments1780000023000 implements MigrationInterface {
  name = 'AddAdminWalletAdjustments1780000023000';

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
        'transfer_in',
        'admin_adjustment'
      ));
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_wallet_ledger_admin_adjustment_request"
      ON wallet_ledger_entries (type, "relatedEntityType", "relatedEntityId")
      WHERE type = 'admin_adjustment'
        AND "relatedEntityType" = 'admin_wallet_adjustment';
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM wallet_ledger_entries
          WHERE type = 'admin_adjustment'
        ) THEN
          RAISE EXCEPTION
            'Rollback refuse: des ajustements admin existent dans wallet_ledger_entries';
        END IF;
      END $$;
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS "UQ_wallet_ledger_admin_adjustment_request";
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
        'subscription_reward',
        'transfer_out',
        'transfer_in'
      ));
    `);
  }
}
