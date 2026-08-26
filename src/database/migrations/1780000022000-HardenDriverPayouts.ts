import { MigrationInterface, QueryRunner } from 'typeorm';

export class HardenDriverPayouts1780000022000 implements MigrationInterface {
  name = 'HardenDriverPayouts1780000022000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE driver_payouts
      ADD COLUMN IF NOT EXISTS "idempotencyKey" character varying(80);
    `);
    await queryRunner.query(`
      UPDATE driver_payouts
      SET "idempotencyKey" = id::text
      WHERE "idempotencyKey" IS NULL;
    `);
    await queryRunner.query(`
      ALTER TABLE driver_payouts
      ALTER COLUMN "idempotencyKey" SET NOT NULL;
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_driver_payouts_driver_idempotency"
      ON driver_payouts ("driverId", "idempotencyKey");
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_driver_payouts_payment_not_null"
      ON driver_payouts ("paymentTransactionId")
      WHERE "paymentTransactionId" IS NOT NULL;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "UQ_driver_payouts_payment_not_null";`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "UQ_driver_payouts_driver_idempotency";`,
    );
    await queryRunner.query(`
      ALTER TABLE driver_payouts
      DROP COLUMN IF EXISTS "idempotencyKey";
    `);
  }
}
