import { MigrationInterface, QueryRunner } from 'typeorm';

export class PayoutRetries1780000105000 implements MigrationInterface {
  name = 'PayoutRetries1780000105000';
  async up(runner: QueryRunner): Promise<void> {
    if (!runner.isTransactionActive)
      throw new Error('Payout retries migration requires a transaction');
    await runner.query("SET LOCAL lock_timeout = '5s'");
    await runner.query("SET LOCAL statement_timeout = '15s'");
    await runner.query(`CREATE TABLE "payout_retries" (
      "kind" varchar(30) NOT NULL CHECK ("kind" IN ('driver_payout', 'referral_withdrawal')),
      "sourceId" uuid NOT NULL,
      "replacementId" uuid NOT NULL,
      "actorId" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
      "expectedReference" varchar(120) NOT NULL,
      "reason" varchar(500) NOT NULL,
      "evidenceReference" varchar(200) NOT NULL,
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY ("kind", "sourceId"),
      CONSTRAINT "UQ_payout_retry_replacement" UNIQUE ("replacementId"),
      CHECK ("sourceId" <> "replacementId")
    )`);
    await runner.query(
      'CREATE INDEX "IDX_payout_retry_actor" ON "payout_retries" ("actorId")',
    );
  }
  async down(runner: QueryRunner): Promise<void> {
    if (!runner.isTransactionActive)
      throw new Error('Payout retries rollback requires a transaction');
    await runner.query("SET LOCAL lock_timeout = '5s'");
    await runner.query("SET LOCAL statement_timeout = '15s'");
    await runner.query('LOCK TABLE "payout_retries" IN ACCESS EXCLUSIVE MODE');
    const [row] = await runner.query(
      'SELECT EXISTS (SELECT 1 FROM "payout_retries") AS used',
    );
    if (row?.used)
      throw new Error(
        'Use a forward migration: payout retry evidence must be preserved',
      );
    await runner.query('DROP TABLE "payout_retries"');
  }
}
