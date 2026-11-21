import { MigrationInterface, QueryRunner } from 'typeorm';

/** Online index for the fresh-driver GPS branch. Never alter the GPS validity rule. */
export class DiscoveryGeographyIndex1780000136000 implements MigrationInterface {
  transaction = false;
  async up(q: QueryRunner) {
    if (q.isTransactionActive) throw new Error('DiscoveryGeographyIndex requires transaction mode each');
    const [prior] = await q.query(`SELECT current_setting('statement_timeout') AS statement_timeout, current_setting('lock_timeout') AS lock_timeout`);
    try {
      await q.query(`SELECT set_config('statement_timeout','5min',false),set_config('lock_timeout','3s',false)`);
      const [existing] = await q.query(`SELECT indisvalid FROM pg_index WHERE indexrelid=to_regclass('"IDX_trips_current_location"')`);
      if (existing && !existing.indisvalid) await q.query('DROP INDEX CONCURRENTLY "IDX_trips_current_location"');
      await q.query('CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_trips_current_location" ON trips USING gist ("currentLocation")');
      const [created] = await q.query(`SELECT indisvalid FROM pg_index WHERE indexrelid=to_regclass('"IDX_trips_current_location"')`);
      if (!created?.indisvalid) throw new Error('Invalid discovery geography index');
    } finally {
      await q.query(`SELECT set_config('statement_timeout',$1,false),set_config('lock_timeout',$2,false)`, [prior.statement_timeout, prior.lock_timeout]);
    }
  }
  async down(q: QueryRunner) {
    if (q.isTransactionActive) {
      await q.query("SET LOCAL lock_timeout='3s'");
      await q.query("SET LOCAL statement_timeout='30s'");
      await q.query('DROP INDEX IF EXISTS "IDX_trips_current_location"');
    } else {
      const [prior] = await q.query(`SELECT current_setting('statement_timeout') AS statement_timeout, current_setting('lock_timeout') AS lock_timeout`);
      try {
        await q.query(`SELECT set_config('statement_timeout','30s',false),set_config('lock_timeout','3s',false)`);
        await q.query('DROP INDEX CONCURRENTLY IF EXISTS "IDX_trips_current_location"');
      } finally {
        await q.query(`SELECT set_config('statement_timeout',$1,false),set_config('lock_timeout',$2,false)`, [prior.statement_timeout, prior.lock_timeout]);
      }
    }
  }
}
