import db from './data-source';
import { FixPublicationRequestUuid1780000057000 } from './migrations/1780000057000-FixPublicationRequestUuid';
import { FixBookingRequestUuid1780000058000, bookingRequestUuidReplacements } from './migrations/1780000058000-FixBookingRequestUuid';

/** Explicit local repair only. Production uses the normal reviewed migration pipeline. */
async function main() {
  const apply = process.argv.includes('--apply');
  const options = db.options as { url?: string; host?: string };
  const host = options.url ? new URL(options.url).hostname : options.host;
  if (process.env.NODE_ENV === 'production' || !host || !['localhost', '127.0.0.1', '::1', '[::1]'].includes(host))
    throw new Error('Local development database required; refusing remote/production target');
  db.setOptions({ synchronize: false, migrationsRun: false, logging: false,
    extra: { ...db.options.extra, max: 1, connectionTimeoutMillis: 5000,
      statement_timeout: 30000, lock_timeout: 5000 } });
  await db.initialize();
  const runner = db.createQueryRunner();
  try {
    await runner.startTransaction();
    if (!apply) await runner.query('SET TRANSACTION READ ONLY');
    else await runner.query('LOCK TABLE typeorm_migrations IN EXCLUSIVE MODE');
    const applied: { name: string }[] = await runner.query('SELECT name FROM typeorm_migrations');
    const pending = db.migrations.map(m => m.name || m.constructor.name).filter(name => !applied.some(m => m.name === name));
    const fixes = [
      { migration: new FixPublicationRequestUuid1780000057000(), timestamp: 1780000057000,
        fn: 'zwanga_publication_cash_guard()', replacements: [['WHERE id = NEW."tripRequestId";', 'WHERE id = NEW."tripRequestId"::uuid;']] },
      { migration: new FixBookingRequestUuid1780000058000(), timestamp: 1780000058000,
        fn: 'zwanga_booking_cash_guard()', replacements: bookingRequestUuidReplacements },
    ];
    const definition = async (fn: string) => {
      const [row] = await runner.query('SELECT pg_get_functiondef($1::regprocedure) AS definition', [fn]);
      return row.definition as string;
    };
    console.log(JSON.stringify({ mode: apply ? 'apply-local' : 'read-only', pending }));
    if (apply && pending.some(name => !fixes.some(fix => fix.migration.name === name)))
      throw new Error('Only UUID repairs may be pending; refusing unrelated migrations');
    for (const fix of fixes) {
      const before = await definition(fix.fn);
      const fixed = fix.replacements.every(([old, corrected]) => !before.includes(old) && before.includes(corrected));
      console.log(JSON.stringify({ function: fix.fn, uuidRepairPresent: fixed }));
      if (!apply) continue;
      if (!pending.includes(fix.migration.name)) {
        if (!fixed) throw new Error('Recorded repair does not match the installed function');
        continue;
      }
      await fix.migration.up(runner);
      const expected = fix.replacements.reduce((sql, [old, corrected]) => sql.replace(old, corrected), before);
      if (await definition(fix.fn) !== expected) throw new Error('Unexpected function change; rolling back');
      await runner.query('INSERT INTO typeorm_migrations (timestamp,name) VALUES ($1,$2)', [fix.timestamp, fix.migration.name]);
    }
    if (apply) {
      await runner.commitTransaction();
      console.log('UUID repair committed and recorded. No application rows changed.');
    } else await runner.rollbackTransaction();
  } catch (error) {
    if (runner.isTransactionActive) await runner.rollbackTransaction();
    throw error;
  } finally { await runner.release(); await db.destroy(); }
}

if (require.main === module) main().catch(error => {
  console.error('Local UUID repair failed:', error instanceof Error ? error.message : 'unknown failure');
  process.exitCode = 1;
});
