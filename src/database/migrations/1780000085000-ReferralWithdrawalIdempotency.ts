import type { MigrationInterface, QueryRunner } from 'typeorm';

export class ReferralWithdrawalIdempotency1780000085000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    if (!runner.isTransactionActive) throw new Error('Referral idempotency requires a transaction');
    await runner.query("SET LOCAL lock_timeout = '5s'");
    await runner.query("SET LOCAL statement_timeout = '30s'");
    await runner.query('ALTER TABLE referral_withdrawals ADD COLUMN "idempotencyKey" uuid NULL');
    await runner.query(`CREATE UNIQUE INDEX "IDX_referral_withdrawal_intent"
      ON referral_withdrawals ("userId", "idempotencyKey") WHERE "idempotencyKey" IS NOT NULL`);
    await runner.query(`CREATE INDEX "IDX_referral_withdrawal_recent" ON referral_withdrawals ("userId", "requestedAt")`);
  }

  async down(runner: QueryRunner): Promise<void> {
    if (!runner.isTransactionActive) throw new Error('Referral idempotency requires a transaction');
    await runner.query("SET LOCAL lock_timeout = '5s'");
    await runner.query("SET LOCAL statement_timeout = '30s'");
    // Dropping a used key would let an old client replay an already paid intent.
    await runner.query('LOCK TABLE referral_withdrawals IN ACCESS EXCLUSIVE MODE');
    const [used] = await runner.query('SELECT EXISTS (SELECT 1 FROM referral_withdrawals WHERE "idempotencyKey" IS NOT NULL) AS used');
    if (used.used) throw new Error('Idempotency keys in use; a forward correction is required');
    await runner.query('DROP INDEX "IDX_referral_withdrawal_recent"');
    await runner.query('DROP INDEX "IDX_referral_withdrawal_intent"');
    await runner.query('ALTER TABLE referral_withdrawals DROP COLUMN "idempotencyKey"');
  }
}
