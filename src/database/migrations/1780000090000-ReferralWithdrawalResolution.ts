import { MigrationInterface, QueryRunner } from 'typeorm';

export class ReferralWithdrawalResolution1780000090000 implements MigrationInterface {
  name = 'ReferralWithdrawalResolution1780000090000';

  async up(runner: QueryRunner): Promise<void> {
    if (!runner.isTransactionActive)
      throw new Error(
        'Referral withdrawal resolution migration requires a transaction',
      );
    await runner.query("SET LOCAL lock_timeout = '5s'");
    await runner.query("SET LOCAL statement_timeout = '15s'");
    await runner.query(`CREATE TABLE "referral_withdrawal_resolutions" (
      "withdrawalId" uuid PRIMARY KEY REFERENCES "referral_withdrawals"("id") ON DELETE RESTRICT,
      "actorId" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
      "expectedReference" varchar(120) NOT NULL,
      "reason" varchar(500) NOT NULL,
      "evidenceReference" varchar(200) NOT NULL,
      "createdAt" timestamptz NOT NULL DEFAULT now()
    )`);
    await runner.query(`CREATE INDEX "IDX_referral_withdrawal_resolution_actor"
      ON "referral_withdrawal_resolutions" ("actorId")`);
  }

  async down(runner: QueryRunner): Promise<void> {
    if (!runner.isTransactionActive)
      throw new Error(
        'Referral withdrawal resolution rollback requires a transaction',
      );
    await runner.query("SET LOCAL lock_timeout = '5s'");
    await runner.query("SET LOCAL statement_timeout = '15s'");
    await runner.query(
      'LOCK TABLE "referral_withdrawal_resolutions" IN ACCESS EXCLUSIVE MODE',
    );
    const [row] = (await runner.query(
      'SELECT EXISTS (SELECT 1 FROM "referral_withdrawal_resolutions") AS used',
    )) as Array<{ used: boolean }>;
    if (row?.used)
      throw new Error(
        'Use a forward migration: withdrawal resolution evidence must be preserved',
      );
    await runner.query('DROP TABLE "referral_withdrawal_resolutions"');
  }
}
