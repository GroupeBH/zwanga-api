import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddPawapayRefunds1780000045000 implements MigrationInterface {
  name = 'AddPawapayRefunds1780000045000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "pawapay_refunds" (
        "id" uuid PRIMARY KEY,
        "paymentTransactionId" uuid NOT NULL REFERENCES "payment_transactions"("id") ON DELETE RESTRICT,
        "createdByUserId" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
        "amount" numeric(10,2) NOT NULL CHECK ("amount" > 0),
        "currency" varchar(8) NOT NULL,
        "reason" varchar(500) NOT NULL,
        "businessReversalReference" varchar(120),
        "status" varchar(20) NOT NULL DEFAULT 'created' CHECK ("status" IN ('created', 'initiated', 'completed', 'failed')),
        "providerStatusCode" varchar(32),
        "providerMessage" varchar(500),
        "rawInitiationResponse" jsonb,
        "rawCheckResponse" jsonb,
        "completedAt" timestamp,
        "createdAt" timestamp NOT NULL DEFAULT now(),
        "updatedAt" timestamp NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      'CREATE INDEX "IDX_pawapay_refunds_payment_created" ON "pawapay_refunds" ("paymentTransactionId", "createdAt")',
    );
    await queryRunner.query(
      'CREATE INDEX "IDX_pawapay_refunds_pending" ON "pawapay_refunds" ("updatedAt") WHERE "status" IN (\'created\', \'initiated\')',
    );
    await queryRunner.query(
      'CREATE INDEX "IDX_payment_transactions_pawapay_pending" ON "payment_transactions" ("updatedAt") WHERE "provider" = \'pawapay\' AND "status" IN (\'pending\', \'initiated\')',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'DROP INDEX "IDX_payment_transactions_pawapay_pending"',
    );
    await queryRunner.query('DROP TABLE "pawapay_refunds"');
  }
}
