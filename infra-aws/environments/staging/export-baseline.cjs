#!/usr/bin/env node
// Explicit, read-only export. Never loads .env, copies rows from business tables,
// contacts AWS, or uploads anything. Review both artifacts before use in staging.
const { Client } = require('pg');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

async function main() {
  const [outputDirectory, baselineCommit] = process.argv.slice(2);
  if (!outputDirectory || !/^[a-f0-9]{40}$/.test(baselineCommit || '')) {
    throw new Error('Usage: node export-baseline.cjs NEW_OUTPUT_DIRECTORY SOURCE_IMAGE_COMMIT_SHA');
  }
  if (!process.env.STAGING_BASELINE_SOURCE_URL) {
    throw new Error('Set STAGING_BASELINE_SOURCE_URL explicitly; application .env is never loaded.');
  }
  const source = new URL(process.env.STAGING_BASELINE_SOURCE_URL);
  if (!['postgres:', 'postgresql:'].includes(source.protocol)) throw new Error('Invalid source URL');
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(source.hostname);
  const caFile = process.env.STAGING_BASELINE_CA_FILE;
  if (!local && !caFile) throw new Error('A trusted CA file is required for a remote source.');
  const destination = path.resolve(outputDirectory);
  if (fs.existsSync(destination)) throw new Error('Output directory must not already exist.');
  const database = decodeURIComponent(source.pathname.slice(1));
  const user = decodeURIComponent(source.username);
  const password = decodeURIComponent(source.password);
  const client = new Client({
    host: source.hostname, port: Number(source.port || 5432), database, user, password,
    ssl: local ? false : { rejectUnauthorized: true, ca: fs.readFileSync(caFile, 'utf8') },
    connectionTimeoutMillis: 10000, query_timeout: 120000,
    options: '-c default_transaction_read_only=on -c statement_timeout=120000 -c lock_timeout=5000',
    application_name: 'zwanga-staging-schema-only-export',
  });
  try {
    await client.connect();
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const version = await client.query('SHOW server_version_num');
    if (Math.floor(Number(version.rows[0].server_version_num) / 10000) !== 18) {
      throw new Error('This staging baseline targets PostgreSQL 18.');
    }
    const snapshot = await client.query('SELECT pg_export_snapshot() AS snapshot');
    const migrations = await client.query('SELECT timestamp,name FROM public.typeorm_migrations ORDER BY timestamp,id');
    const policy = await client.query('SELECT enabled FROM public.financial_rollout WHERE id=true');
    if (!migrations.rowCount || policy.rowCount !== 1) throw new Error('Incomplete source baseline metadata.');
    fs.mkdirSync(destination, { mode: 0o700 });
    const schemaPath = path.join(destination, 'schema.dump');
    const executable = process.env.STAGING_BASELINE_PG_DUMP || 'pg_dump';
    await new Promise((resolve, reject) => {
      const child = spawn(executable, [
        '--schema-only', '--schema=public', '--no-owner', '--no-privileges', '--format=custom',
        '--lock-wait-timeout=5s', `--snapshot=${snapshot.rows[0].snapshot}`, `--file=${schemaPath}`,
      ], {
        windowsHide: true, timeout: 120000, stdio: ['ignore', 'ignore', 'pipe'],
        env: { ...process.env, PGHOST: source.hostname, PGPORT: source.port || '5432',
          PGDATABASE: database, PGUSER: user, PGPASSWORD: password,
          PGSSLMODE: local ? 'disable' : 'verify-full', PGSSLROOTCERT: caFile || '',
          PGOPTIONS: '-c default_transaction_read_only=on -c statement_timeout=120000 -c lock_timeout=5000' },
      });
      // Drain without echoing errors containing connection details.
      child.stderr.resume();
      child.on('error', () => reject(new Error('Unable to run pg_dump.')));
      child.on('close', code => code === 0 ? resolve() : reject(new Error('Schema export failed. No usable manifest was created.')));
    });
    fs.chmodSync(schemaPath, 0o600);
    const manifest = {
      baselineCommit,
      schemaSha256: createHash('sha256').update(fs.readFileSync(schemaPath)).digest('hex'),
      financialPolicyEnabled: policy.rows[0].enabled,
      migrations: migrations.rows.map(row => ({ timestamp: Number(row.timestamp), name: row.name })),
    };
    fs.writeFileSync(path.join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx', mode: 0o600 });
    await client.query('COMMIT');
    console.log('Schema and migration metadata exported from one read-only snapshot. Review before uploading; no business rows exported.');
  } finally {
    await client.end();
  }
}

main().catch(() => {
  console.error('Baseline export failed. Check explicit source settings, CA, PostgreSQL tools and the new output directory. Connection details are intentionally redacted.');
  process.exitCode = 1;
});
