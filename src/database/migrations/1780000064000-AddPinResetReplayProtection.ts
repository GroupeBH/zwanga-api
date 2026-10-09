import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddPinResetReplayProtection1780000064000 implements MigrationInterface {
  name = 'AddPinResetReplayProtection1780000064000';

  async up(runner: QueryRunner): Promise<void> {
    if (!runner.isTransactionActive)
      throw new Error('PIN reset replay protection requires a transaction');
    await runner.query("SET LOCAL lock_timeout = '5s'");
    await runner.query("SET LOCAL statement_timeout = '15s'");
    // Nullable, no backfill. Commit proof consumption and the new PIN together.
    await runner.query(
      'ALTER TABLE users ADD COLUMN IF NOT EXISTS "lastPinResetTokenHash" text',
    );
  }

  down(): Promise<void> {
    return Promise.reject(
      new Error('Keep PIN reset replay protection; use a forward migration.'),
    );
  }
}
