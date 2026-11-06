import { MigrationInterface, QueryRunner } from 'typeorm';

const tables = [
  'trips',
  'bookings',
  'trip_requests',
  'payment_transactions',
  'kyc_documents',
  'user_reports',
  'support_tickets',
  'ratings',
  'wallet_ledger_entries',
];
/** Online, additive and restartable. Uses the datasource's `each` transaction mode. */
export class AdminAnalyticsIndexes1780000114000 implements MigrationInterface {
  name = 'AdminAnalyticsIndexes1780000114000';
  transaction = false;
  async up(runner: QueryRunner) {
    await this.bounded(runner, async () => {
      for (const table of tables) {
        const name = `IDX_admin_${table}_created`;
        await this.repairInvalidIndex(runner, name);
        await runner.query(
          `CREATE INDEX CONCURRENTLY IF NOT EXISTS "${name}" ON "${table}" ("createdAt" DESC,id ASC)`,
        );
        const [index] = await runner.query(
          'SELECT indisvalid FROM pg_index WHERE indexrelid=to_regclass($1)',
          [`"${name}"`],
        );
        if (!index?.indisvalid) throw new Error(`Invalid index: ${name}`);
      }
      await this.repairInvalidIndex(runner, 'IDX_admin_rating_trip_driver');
      await runner.query(
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_admin_rating_trip_driver" ON ratings (("tripId"::text),("ratedUserId"::text))`,
      );
      const [index] = await runner.query(
        `SELECT indisvalid FROM pg_index WHERE indexrelid=to_regclass('"IDX_admin_rating_trip_driver"')`,
      );
      if (!index?.indisvalid)
        throw new Error('Invalid index: IDX_admin_rating_trip_driver');
    });
  }
  async down(runner: QueryRunner) {
    // TypeORM's revert executor ignores a migration's transaction=false flag.
    // Keep standard migration:revert usable, with short bounded locks. An
    // explicitly non-transactional rollback still uses concurrent drops below.
    if (runner.isTransactionActive) {
      await runner.query("SET LOCAL lock_timeout='3s'");
      await runner.query("SET LOCAL statement_timeout='30s'");
      await runner.query('DROP INDEX IF EXISTS "IDX_admin_rating_trip_driver"');
      for (const table of [...tables].reverse())
        await runner.query(`DROP INDEX IF EXISTS "IDX_admin_${table}_created"`);
      return;
    }
    await this.bounded(runner, async () => {
      await runner.query(
        'DROP INDEX CONCURRENTLY IF EXISTS "IDX_admin_rating_trip_driver"',
      );
      for (const table of [...tables].reverse())
        await runner.query(
          `DROP INDEX CONCURRENTLY IF EXISTS "IDX_admin_${table}_created"`,
        );
    });
  }
  private async repairInvalidIndex(runner: QueryRunner, name: string) {
    const [index] = await runner.query(
      'SELECT indisvalid FROM pg_index WHERE indexrelid=to_regclass($1)',
      [`"${name}"`],
    );
    // A cancelled concurrent build can leave an unusable index. IF NOT EXISTS
    // alone would silently preserve it on the next deployment.
    if (index && !index.indisvalid)
      await runner.query(`DROP INDEX CONCURRENTLY IF EXISTS "${name}"`);
  }
  private async bounded(runner: QueryRunner, work: () => Promise<void>) {
    if (runner.isTransactionActive)
      throw new Error(
        'AdminAnalyticsIndexes requires migration transaction mode each (not all)',
      );
    const [prior] = await runner.query(
      `SELECT current_setting('lock_timeout') AS lock_timeout,current_setting('statement_timeout') AS statement_timeout`,
    );
    try {
      await runner.query(
        `SELECT set_config('lock_timeout','3s',false),set_config('statement_timeout','5min',false)`,
      );
      await work();
    } finally {
      await runner.query(
        `SELECT set_config('lock_timeout',$1,false),set_config('statement_timeout',$2,false)`,
        [prior.lock_timeout, prior.statement_timeout],
      );
    }
  }
}
