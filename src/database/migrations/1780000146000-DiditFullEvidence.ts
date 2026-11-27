import { MigrationInterface, QueryRunner } from 'typeorm';

export class DiditFullEvidence1780000146000 implements MigrationInterface {
  name = 'DiditFullEvidence1780000146000';
  async up(runner: QueryRunner): Promise<void> {
    if (!runner.isTransactionActive)
      throw new Error('KYC archive migration requires a transaction');
    await runner.query("SET LOCAL lock_timeout='5s'");
    await runner.query("SET LOCAL statement_timeout='15s'");
    await runner.query(`ALTER TABLE kyc_evidence_archives
      ADD COLUMN "sourceFingerprint" text,
      ADD COLUMN revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
      ADD COLUMN "capturedRevision" integer NOT NULL DEFAULT 0 CHECK ("capturedRevision" >= 0),
      ADD COLUMN "exportId" uuid,
      ADD COLUMN "exportRevision" integer;
      ALTER TABLE kyc_evidence_archives DROP CONSTRAINT kyc_evidence_archives_attempts_check;
      ALTER TABLE kyc_evidence_archives ADD CONSTRAINT kyc_evidence_archives_attempts_check CHECK (attempts BETWEEN 0 AND 12);
      COMMENT ON COLUMN kyc_evidence_archives."sourceFingerprint" IS
        'SHA-256 deduplication only; provider payloads and signed URLs stay out of SQL';`);
  }
  async down(): Promise<void> {
    throw new Error(
      'Preserve full KYC archive revisions and cleanup records; explicit migration required',
    );
  }
}
