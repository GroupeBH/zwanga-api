import { MigrationInterface, QueryRunner } from 'typeorm';

export class VerifiedRatingInteractions1780000068000 implements MigrationInterface {
  name = 'VerifiedRatingInteractions1780000068000';
  async up(runner: QueryRunner): Promise<void> {
    if (!runner.isTransactionActive)
      throw new Error('Verified ratings require a transaction');
    await runner.query("SET LOCAL lock_timeout = '5s'");
    await runner.query("SET LOCAL statement_timeout = '30s'");
    // Preserve historical reviews (including duplicates) without labelling them verified.
    await runner.query(
      'ALTER TABLE ratings ADD COLUMN "verificationVersion" smallint NOT NULL DEFAULT 0',
    );
    await runner.query(`CREATE UNIQUE INDEX "UQ_ratings_verified_interaction"
      ON ratings ("raterId", "ratedUserId", "tripId") WHERE "verificationVersion" = 1`);
  }
  async down(): Promise<void> {
    throw new Error(
      'Use a forward migration to preserve verified review integrity',
    );
  }
}
