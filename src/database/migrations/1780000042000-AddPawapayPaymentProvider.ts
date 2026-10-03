import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddPawapayPaymentProvider1780000042000
  implements MigrationInterface
{
  name = 'AddPawapayPaymentProvider1780000042000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM pg_type
          WHERE typname = 'payment_transactions_provider_enum'
        ) THEN
          ALTER TYPE "public"."payment_transactions_provider_enum"
          ADD VALUE IF NOT EXISTS 'pawapay';
        END IF;
      END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM payment_transactions
          WHERE provider::text = 'pawapay'
        ) THEN
          RAISE EXCEPTION
            'Rollback refuse: des transactions PawaPay existent dans payment_transactions';
        END IF;
      END $$;
    `);
  }
}
