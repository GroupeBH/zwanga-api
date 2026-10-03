import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddDriverPayoutRecovery1780000046000 implements MigrationInterface {
  name = 'AddDriverPayoutRecovery1780000046000';

  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`ALTER TABLE "driver_payouts"
      ADD COLUMN "reviewRequestedAt" timestamptz,
      ADD COLUMN "reviewResolvedAt" timestamptz,
      ADD COLUMN "fundsReleasedAt" timestamptz,
      ADD COLUMN "lastReconciledAt" timestamptz,
      ADD COLUMN "recoveryBlocked" boolean NOT NULL DEFAULT false`);
    await runner.query(`CREATE INDEX "IDX_driver_payouts_reconciliation"
      ON "driver_payouts" ("lastReconciledAt", "createdAt")
      WHERE "status" IN ('pending', 'initiated')`);
    await runner.query(`CREATE INDEX "IDX_driver_payouts_recovery_blocked"
      ON "driver_payouts" ("driverId") WHERE "recoveryBlocked" = true`);
    await runner.query(`CREATE TABLE "driver_payout_events" (
      "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
      "payoutId" uuid NOT NULL REFERENCES "driver_payouts"("id") ON DELETE RESTRICT,
      "actorId" uuid REFERENCES "users"("id") ON DELETE RESTRICT,
      "action" varchar(40) NOT NULL CHECK ("action" IN ('review_requested',
        'released_confirmed_not_paid', 'reconciled', 'late_success', 'late_success_review_closed')),
      "reason" varchar(500) NOT NULL,
      "evidenceReference" varchar(200),
      "details" jsonb,
      "createdAt" timestamptz NOT NULL DEFAULT now()
    )`);
    await runner.query(`CREATE INDEX "IDX_driver_payout_events_payout_created"
      ON "driver_payout_events" ("payoutId", "createdAt")`);
  }

  async down(runner: QueryRunner): Promise<void> {
    // Preserve audit evidence: do not roll back once recovery has been used.
    await runner.query(`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM "driver_payout_events") THEN
        RAISE EXCEPTION 'Driver payout recovery audit exists; rollback refused';
      END IF;
    END $$`);
    await runner.query('DROP TABLE "driver_payout_events"');
    await runner.query('DROP INDEX "IDX_driver_payouts_reconciliation"');
    await runner.query('DROP INDEX "IDX_driver_payouts_recovery_blocked"');
    await runner.query(`ALTER TABLE "driver_payouts"
      DROP COLUMN "reviewRequestedAt", DROP COLUMN "reviewResolvedAt",
      DROP COLUMN "fundsReleasedAt", DROP COLUMN "lastReconciledAt",
      DROP COLUMN "recoveryBlocked"`);
  }
}
