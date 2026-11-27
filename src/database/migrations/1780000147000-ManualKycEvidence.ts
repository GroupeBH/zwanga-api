import { MigrationInterface, QueryRunner } from 'typeorm';
export class ManualKycEvidence1780000147000 implements MigrationInterface {
  name = 'ManualKycEvidence1780000147000';
  async up(runner: QueryRunner): Promise<void> {
    if (!runner.isTransactionActive)
      throw new Error('KYC migration requires a transaction');
    await runner.query("SET LOCAL lock_timeout='5s'");
    await runner.query("SET LOCAL statement_timeout='15s'");
    await runner.query(`ALTER TABLE kyc_evidence_archives ADD COLUMN "captureKind" text NOT NULL DEFAULT 'provider'
      CHECK ("captureKind" IN ('provider','manual'));
      ALTER TABLE kyc_evidence_access_log DROP CONSTRAINT kyc_evidence_access_log_action_check;
      ALTER TABLE kyc_evidence_access_log ADD CONSTRAINT kyc_evidence_access_log_action_check
        CHECK (action IN ('read','file','enqueue','purge','purge_request','manual_save'));
      COMMENT ON COLUMN kyc_evidence_archives."captureKind" IS 'Manual snapshots are never collected by the Didit worker';`);
  }
  async down(): Promise<void> {
    throw new Error(
      'Preserve manual KYC audit trail; explicit migration required',
    );
  }
}
