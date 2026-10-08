import { MigrationInterface, QueryRunner } from 'typeorm';

export class KycEvidenceIndefiniteRetention1780000062000 implements MigrationInterface {
  name = 'KycEvidenceIndefiniteRetention1780000062000';

  async up(runner: QueryRunner): Promise<void> {
    if (!runner.isTransactionActive)
      throw new Error('KYC retention migration requires a transaction');
    await runner.query("SET LOCAL lock_timeout='5s'");
    await runner.query("SET LOCAL statement_timeout='15s'");
    // Preserve existing deadlines and purge tombstones; never extend retention implicitly.
    await runner.query(
      `ALTER TABLE kyc_evidence_archives ALTER COLUMN "expiresAt" DROP NOT NULL`,
    );
    await runner.query(`COMMENT ON COLUMN kyc_evidence_archives."expiresAt" IS
      'NULL: no age-based expiration; explicit purge and dossier/account deletion still apply.'`);
  }

  async down(): Promise<void> {
    throw new Error(
      'Set an explicit retention policy for indefinite KYC archives before reverting',
    );
  }
}
