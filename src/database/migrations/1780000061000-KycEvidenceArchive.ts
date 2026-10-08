import { MigrationInterface, QueryRunner } from 'typeorm';

export class KycEvidenceArchive1780000061000 implements MigrationInterface {
  name = 'KycEvidenceArchive1780000061000';
  async up(runner: QueryRunner): Promise<void> {
    if (!runner.isTransactionActive)
      throw new Error('KYC archive requires a transaction');
    await runner.query("SET LOCAL lock_timeout='5s'");
    await runner.query("SET LOCAL statement_timeout='15s'");
    await runner.query(`CREATE TABLE kyc_evidence_archives (
      id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
      "kycId" uuid REFERENCES kyc_documents(id) ON DELETE SET NULL,
      "userId" uuid REFERENCES users(id) ON DELETE SET NULL,
      "sessionId" text NOT NULL,
      state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','processing','ready','partial','failed','purged')),
      attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
      "nextAttemptAt" timestamptz NOT NULL DEFAULT now(),
      "leaseToken" uuid, "leaseUntil" timestamptz,
      "objectKeys" jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof("objectKeys")='array'),
      "objectKey" text, "errorCode" text,
      "expiresAt" timestamptz NOT NULL,
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "archivedAt" timestamptz,
      UNIQUE ("kycId","sessionId")
    );
    CREATE INDEX "IDX_kyc_evidence_user" ON kyc_evidence_archives ("userId");
    CREATE INDEX "IDX_kyc_evidence_pending" ON kyc_evidence_archives ("nextAttemptAt",id)
      WHERE state IN ('pending','processing');
    CREATE INDEX "IDX_kyc_evidence_expiry" ON kyc_evidence_archives ("expiresAt",id) WHERE state <> 'purged';
    CREATE INDEX "IDX_kyc_evidence_orphan" ON kyc_evidence_archives (id) WHERE "kycId" IS NULL AND state <> 'purged';
    CREATE TABLE kyc_evidence_access_log (
      id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
      "archiveId" uuid NOT NULL REFERENCES kyc_evidence_archives(id),
      "adminId" uuid REFERENCES users(id) ON DELETE SET NULL,
      action text NOT NULL CHECK (action IN ('read','file','enqueue','purge','purge_request')),
      "createdAt" timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX "IDX_kyc_evidence_access_archive" ON kyc_evidence_access_log ("archiveId","createdAt");
    CREATE INDEX "IDX_kyc_evidence_access_admin" ON kyc_evidence_access_log ("adminId");`);
  }
  async down(): Promise<void> {
    throw new Error(
      'KYC evidence requires an explicit purge before any schema removal',
    );
  }
}
