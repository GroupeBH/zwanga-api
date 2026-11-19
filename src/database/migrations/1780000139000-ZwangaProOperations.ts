import { MigrationInterface, QueryRunner } from 'typeorm';
export class ZwangaProOperations1780000139000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    if (!q.isTransactionActive)
      throw Error('Zwanga Pro requires a transaction');
    await q.query("SET LOCAL lock_timeout='5s'");
    await q.query(`CREATE TABLE pro_credit_reschedules (
      id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), "creditId" uuid NOT NULL REFERENCES asset_credits(id),
      "proposedBy" uuid NOT NULL REFERENCES users(id), "approvedBy" uuid REFERENCES users(id),
      "expectedRemainingMinor" bigint NOT NULL CHECK("expectedRemainingMinor">0), "expectedVersion" integer NOT NULL,
      installments integer NOT NULL CHECK(installments BETWEEN 1 AND 120), period text NOT NULL CHECK(period IN ('week','month')),
      reason text NOT NULL, "consentedAt" timestamptz, "approvedAt" timestamptz, "createdAt" timestamptz NOT NULL DEFAULT now(),
      CHECK("approvedBy" IS NULL OR ("approvedBy"<>"proposedBy" AND "consentedAt" IS NOT NULL))
    );
    CREATE INDEX pro_reschedule_credit ON pro_credit_reschedules("creditId","createdAt");
    CREATE INDEX pro_reschedule_proposer ON pro_credit_reschedules("proposedBy");
    CREATE INDEX pro_reschedule_approver ON pro_credit_reschedules("approvedBy");`);
  }
  down(): Promise<void> {
    throw Error(
      'Rescheduling consents must be preserved; use a forward migration.',
    );
  }
}
