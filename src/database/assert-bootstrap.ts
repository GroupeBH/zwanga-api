import dataSource from './data-source';

const REQUIRED_BASELINE_TABLES = ['users', 'trips', 'bookings'];

async function main(): Promise<void> {
  await dataSource.initialize();

  try {
    const rows = (await dataSource.query(
      `
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = ANY($1)
      `,
      [REQUIRED_BASELINE_TABLES],
    )) as Array<{ table_name: string }>;

    const existingTables = new Set(rows.map((row) => row.table_name));
    const missingTables = REQUIRED_BASELINE_TABLES.filter(
      (table) => !existingTables.has(table),
    );

    if (missingTables.length > 0) {
      console.error(
        [
          'RDS bootstrap check failed: the target database does not contain the expected baseline tables.',
          `Missing tables: ${missingTables.join(', ')}`,
          '',
          'This project previously used TYPEORM_SYNCHRONIZE=true, so the current migrations are incremental migrations, not a full initial schema.',
          'Import the existing Neon production database into RDS first, then run migrations again.',
          '',
          'Expected bootstrap flow:',
          '1. Store the Neon DATABASE_URL in SSM.',
          '2. Freeze writes on the old Render/Neon production app.',
          '3. Run infra-aws/scripts/run-neon-to-rds-import.sh.',
          '4. Re-run the GitHub Actions deployment.',
        ].join('\n'),
      );
      process.exitCode = 70;
      return;
    }

    const migrationTableRows = (await dataSource.query(
      `
        SELECT EXISTS (
          SELECT 1
          FROM information_schema.tables
          WHERE table_schema = 'public'
            AND table_name = 'typeorm_migrations'
        ) AS exists
      `,
    )) as Array<{ exists: boolean }>;

    const migrationTableExists = Boolean(migrationTableRows[0]?.exists);
    console.log(
      `RDS bootstrap check passed: found baseline tables ${REQUIRED_BASELINE_TABLES.join(
        ', ',
      )}. typeorm_migrations table exists: ${migrationTableExists}.`,
    );
  } finally {
    await dataSource.destroy();
  }
}

void main().catch(async (error) => {
  console.error('RDS bootstrap check failed with an unexpected error:', error);

  if (dataSource.isInitialized) {
    await dataSource.destroy();
  }

  process.exitCode = 1;
});
