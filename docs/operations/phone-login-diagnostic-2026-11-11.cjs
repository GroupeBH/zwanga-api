'use strict';

// One-shot ECS diagnostic. No Nest bootstrap, dotenv, migrations, SMS or writes.
// Output is limited to user-provided suffixes, counts and account states.
const { Client } = require('pg');
const { readFileSync } = require('node:fs');
const PREFIX = 'PHONE_LOGIN_AUDIT_20261111';
const emit = (kind, data) => console.log(PREFIX + ' ' + JSON.stringify({ kind, ...data }));
const deadline = setTimeout(() => {
  emit('failure', { code: 'OVERALL_DEADLINE' });
  process.exit(2);
}, 45000);
let client;

(async () => {
  const env = process.env;
  let connection;
  if (env.DATABASE_URL) {
    const url = new URL(env.DATABASE_URL);
    // Preserve credentials in memory only, never log them. Explicit TLS below.
    for (const key of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert']) url.searchParams.delete(key);
    connection = { connectionString: url.toString() };
  } else {
    if (!env.DATABASE_HOST || !env.DATABASE_USER || !env.DATABASE_NAME) {
      throw Object.assign(new Error(), { code: 'CONFIG_MISSING' });
    }
    connection = {
      host: env.DATABASE_HOST, port: Number(env.DATABASE_PORT || 5432),
      user: env.DATABASE_USER, password: env.DATABASE_PASSWORD, database: env.DATABASE_NAME,
    };
  }
  client = new Client({
    ...connection,
    ssl: {
      rejectUnauthorized: true,
      ca: readFileSync(env.DATABASE_SSL_CA_FILE || env.NODE_EXTRA_CA_CERTS ||
        '/usr/local/share/ca-certificates/aws-rds-global-bundle.crt', 'utf8'),
    },
    application_name: 'phone-login-readonly-20261111',
    connectionTimeoutMillis: 5000, statement_timeout: 8000, query_timeout: 10000,
    lock_timeout: 1000, idle_in_transaction_session_timeout: 15000,
    options: '-c default_transaction_read_only=on',
  });
  await client.connect();
  await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const { rows: [schema] } = await client.query(`SELECT
    current_setting('transaction_read_only') AS read_only,
    to_regprocedure('public.zwanga_canonical_phone(text)') IS NOT NULL AS normalization,
    to_regclass('public.user_phone_identities') IS NOT NULL AS reservations`);
  emit('schema', schema);
  if (schema.read_only !== 'on' || !schema.normalization || !schema.reservations) {
    throw Object.assign(new Error(), { code: 'SCHEMA_NOT_READY' });
  }
  const { rows } = await client.query(`WITH candidates AS MATERIALIZED (
    SELECT public.zwanga_canonical_phone(phone) AS canonical, role::text AS role,
      status::text AS status, "isActive" AS active,
      CASE WHEN phone LIKE '+%' THEN 'international_plus'
        WHEN phone LIKE '00%' THEN 'international_00'
        WHEN phone LIKE '0%' THEN 'local' ELSE 'other' END AS format
    FROM public.users
    WHERE right(public.zwanga_canonical_phone(phone),3) = ANY($1::text[])
  ), groups AS (
    SELECT canonical, count(*)::int AS accounts,
      count(*) FILTER (WHERE active AND status NOT IN ('inactive','suspended'))::int AS enabled_accounts,
      jsonb_agg(jsonb_build_object('role',role,'status',status,'active',active,'format',format)
        ORDER BY role,status,format) AS members
    FROM candidates GROUP BY canonical
  )
  SELECT right(g.canonical,3) AS suffix,
    row_number() OVER (PARTITION BY right(g.canonical,3) ORDER BY g.canonical)::int AS suffix_group,
    g.accounts, g.enabled_accounts, g.members, (g.accounts <> 1) AS blocked_by_ambiguity,
    (i.phone IS NOT NULL) AS reservation_present,
    (i.phone IS NOT NULL AND i."userId" IS NULL) AS reserved_for_review
  FROM groups g LEFT JOIN public.user_phone_identities i ON i.phone=g.canonical
  ORDER BY suffix,suffix_group LIMIT 51`, [['710', '654']]);
  for (const row of rows.slice(0,50)) emit('group', row);
  emit('summary', {
    groupsReturned: Math.min(rows.length,50), truncated: rows.length > 50,
    requestedSuffixes: ['710','654'],
    unmatchedSuffixes: ['710','654'].filter(suffix => !rows.some(row => row.suffix === suffix)),
  });
  await client.query('ROLLBACK');
  await client.end();
  client = undefined;
  emit('complete', { writes: false });
})().catch(async error => {
  // Do not expose PostgreSQL detail, query parameters, credentials or stack.
  const code = typeof error?.code === 'string' && /^[A-Z0-9_]{2,40}$/.test(error.code)
    ? error.code : 'DIAGNOSTIC_FAILED';
  emit('failure', { code });
  if (client) {
    try { await client.query('ROLLBACK'); } catch {}
    try { await client.end(); } catch {}
  }
  process.exitCode = 1;
}).finally(() => clearTimeout(deadline));
