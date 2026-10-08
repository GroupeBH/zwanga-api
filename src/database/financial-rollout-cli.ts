import db from './data-source';
import {
  activateFinancialRollout,
  assertLegacyRolloutSafe,
} from './financial-rollout';

async function main() {
  const command = process.argv[2];
  if (!['prepare', 'prepare-legacy', 'activate', 'status'].includes(command))
    throw new Error('Expected prepare, prepare-legacy, activate or status');
  // Apply bounds to every connection used by the migration executor, not a
  // random pooled connection. These limits do not change API request settings.
  db.setOptions({
    extra: {
      ...db.options.extra,
      max: 1,
      connectionTimeoutMillis: 5_000,
      lock_timeout: 5_000,
      statement_timeout: 60_000,
      idle_in_transaction_session_timeout: 60_000,
    },
  });
  await db.initialize();
  try {
    if (command === 'prepare-legacy') await assertLegacyRolloutSafe(db);
    if (command.startsWith('prepare'))
      await db.runMigrations({ transaction: 'all' });
    if (command === 'activate') await activateFinancialRollout(db);
    const [state] = await db.query(
      'SELECT enabled,"contractVersion" FROM financial_rollout WHERE id=true',
    );
    if (!state || state.contractVersion !== 1)
      throw new Error('Financial schema contract is not ready');
    if (command === 'prepare-legacy' && state.enabled)
      throw new Error('Refusing activation while legacy servers remain');
    console.log(
      JSON.stringify({
        financialRollout: state.enabled ? 'active' : 'prepared',
        contractVersion: state.contractVersion,
      }),
    );
  } finally {
    await db.destroy();
  }
}

if (require.main === module)
  main().catch((error) => {
    // Do not print connection options, SQL parameters or provider credentials.
    console.error(
      `Financial rollout failed: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
    process.exitCode = 1;
  });
