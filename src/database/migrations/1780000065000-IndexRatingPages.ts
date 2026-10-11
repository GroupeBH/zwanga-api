import { MigrationInterface, QueryRunner } from 'typeorm';

export class IndexRatingPages1780000065000 implements MigrationInterface {
  name = 'IndexRatingPages1780000065000';

  async up(runner: QueryRunner): Promise<void> {
    if (!runner.isTransactionActive) throw new Error('Rating index requires a transaction');
    await runner.query("SET LOCAL lock_timeout = '5s'");
    await runner.query("SET LOCAL statement_timeout = '30s'");
    await runner.query('CREATE INDEX IF NOT EXISTS "IDX_ratings_user_page" ON ratings ("ratedUserId", "createdAt", id)');
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query('DROP INDEX IF EXISTS "IDX_ratings_user_page"');
  }
}
