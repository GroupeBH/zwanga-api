import { MigrationInterface, QueryRunner } from 'typeorm';

export class AwsKycSessions1780000069000 implements MigrationInterface {
  name = 'AwsKycSessions1780000069000';
  async up(r: QueryRunner) {
    await r.query(`SET LOCAL lock_timeout = '5s'`);
    await r.query(`SET LOCAL statement_timeout = '20s'`);
    // The new enum value is not used by any DML until this migration commits.
    await r.query(
      `ALTER TYPE kyc_documents_provider_enum ADD VALUE IF NOT EXISTS 'aws'`,
    );
    await r.query(`CREATE TABLE aws_kyc_sessions (
      id uuid PRIMARY KEY, "userId" uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      "kycId" uuid NOT NULL UNIQUE REFERENCES kyc_documents(id) ON DELETE CASCADE,
      "requestId" uuid NOT NULL, "archiveId" uuid NOT NULL REFERENCES kyc_evidence_archives(id),
      "documentType" text NOT NULL CHECK ("documentType" IN ('voter_card','passport','driving_license')),
      "identityHash" text NOT NULL, "consentVersion" text NOT NULL,
      state text NOT NULL CHECK (state IN ('uploading','documents','ready','creating','liveness','compare','review','failed')),
      "objectKey" text, "livenessId" uuid UNIQUE, region text NOT NULL,
      checks jsonb NOT NULL DEFAULT '{}', failures integer NOT NULL DEFAULT 0 CHECK (failures BETWEEN 0 AND 3),
      runs integer NOT NULL DEFAULT 0 CHECK (runs BETWEEN 0 AND 4),
      "leaseToken" uuid, "leaseUntil" timestamptz, "expiresAt" timestamptz NOT NULL,
      "nextAttemptAt" timestamptz NOT NULL DEFAULT now(), "errorCode" text, "reviewNote" text,
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT "UQ_aws_kyc_request" UNIQUE ("userId","requestId")
    );
    CREATE UNIQUE INDEX "UQ_aws_kyc_active" ON aws_kyc_sessions ("userId") WHERE state <> 'failed';
    CREATE INDEX "IDX_aws_kyc_user_created" ON aws_kyc_sessions ("userId","createdAt");
    CREATE INDEX "IDX_aws_kyc_created" ON aws_kyc_sessions ("createdAt");
    CREATE INDEX "IDX_aws_kyc_archive" ON aws_kyc_sessions ("archiveId");
    CREATE INDEX "IDX_aws_kyc_queue" ON aws_kyc_sessions ("nextAttemptAt") WHERE state IN ('documents','liveness','compare');
    CREATE TABLE aws_kyc_budget (
      period text PRIMARY KEY, reserved integer NOT NULL DEFAULT 0 CHECK (reserved >= 0)
    );`);
  }
  async down(): Promise<void> {
    throw new Error(
      'AWS KYC evidence and budget reservations require an explicit retention/purge review before rollback. Disable AWS_KYC_ENABLED instead.',
    );
  }
}
