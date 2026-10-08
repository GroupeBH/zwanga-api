// Run inside the existing backend image, never boot Nest or any scheduler.
// Outputs configuration/schema checks only, never tokens, URLs or user data.
const assert = require('node:assert/strict');
const { Client } = require('pg');
const { buildTypeOrmDataSourceOptions } = require('/app/dist/database/typeorm-options');
const { databaseMigrations } = require('/app/dist/database/migrations');
const { DriverDispatchService } = require('/app/dist/trip-requests/dispatch/dispatch.service');
const { NotificationService } = require('/app/dist/notifications/notifications.service');

async function main() {
  const options = buildTypeOrmDataSourceOptions(process.env);
  assert.ok(options.url && options.ssl && options.ssl.rejectUnauthorized, 'TLS_REQUIRED');
  const connection = new URL(options.url);
  for (const key of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert']) connection.searchParams.delete(key);
  const client = new Client({ connectionString: connection.toString(), ssl: options.ssl,
    connectionTimeoutMillis: 8000, statement_timeout: 5000,
    application_name: 'zwanga-dispatch-preflight',
    options: '-c default_transaction_read_only=on' });
  const result = { readOnly: true, schema: false, migrations: false, code: false,
    driverPayload: false, broadcastPreserved: false,
    dispatchConfigured: process.env.DRIVER_DISPATCH_ENABLED === 'true' };
  try {
    await client.connect();
    await client.query('BEGIN READ ONLY');
    await client.query("SET LOCAL lock_timeout = '2s'");
    const columns = (await client.query(`SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
    [['driver_notification_clients', 'driver_dispatch_presence', 'trip_request_dispatch_offers', 'trip_requests', 'notifications']])).rows;
    for (const [table, names] of Object.entries({
      driver_notification_clients: ['userId', 'tokenHash'],
      driver_dispatch_presence: ['driverId', 'vehicleId', 'leaseId', 'seats', 'position', 'expiresAt', 'updatedAt'],
      trip_request_dispatch_offers: ['id', 'requestId', 'driverId', 'vehicleId', 'seats', 'status', 'expiresAt'],
      trip_requests: ['immediateDispatch', 'dispatchCheckedAt'], notifications: ['eventKey'],
    })) {
      for (const name of names) assert.ok(columns.some(c => c.table_name === table && c.column_name === name), 'SCHEMA_INCOMPLETE');
    }
    const indexes = (await client.query(`SELECT c.relname AS name, i.indisvalid AS valid,
      i.indisunique AS unique FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public'
      AND c.relname = ANY($1::text[])`,
    [['dispatch_presence_position_idx', 'dispatch_presence_expiry_idx', 'dispatch_one_pending_request_idx',
      'dispatch_one_pending_driver_idx', 'dispatch_deadline_idx', 'dispatch_waiting_requests_idx']])).rows;
    assert.equal(indexes.length, 6, 'INDEXES_INCOMPLETE');
    assert.ok(indexes.every(i => i.valid), 'INDEX_INVALID');
    assert.ok(indexes.filter(i => i.name.startsWith('dispatch_one_pending')).every(i => i.unique), 'UNIQUENESS_MISSING');
    const applied = new Set((await client.query('SELECT name FROM public.typeorm_migrations')).rows.map(r => r.name));
    assert.ok(applied.has('AddDriverDispatch1780000048000'), 'DISPATCH_MIGRATION_MISSING');
    assert.ok(databaseMigrations.every(migration => applied.has(migration.name)), 'MIGRATIONS_PENDING');
    await client.query('ROLLBACK');
    result.schema = result.migrations = true;
  } finally { await client.end(); }

  assert.equal(typeof DriverDispatchService.prototype.recordPosition, 'function', 'AUTOMATIC_PRESENCE_CODE_MISSING');
  result.code = true;
  // Exercise the compiled serializer with synthetic data and a fake transport.
  const originalFetch = global.fetch;
  let payload;
  global.fetch = async (_url, request) => {
    payload = JSON.parse(request.body);
    return { ok: true, json: async () => ({ data: { status: 'ok', id: 'preflight-no-push-sent' } }) };
  };
  try {
    for (const version of [0, 2]) {
      const service = Object.assign(Object.create(NotificationService.prototype), {
        configService: { get: () => 'true' },
        notificationRepository: { manager: { query: async () => version ? [{ version }] : [] } },
      });
      for (const type of ['new_booking', 'driver_dispatch_offer', 'trip_request']) {
        await service.sendExpoPushNotification({ userId: 'synthetic', title: 'Preflight', body: 'No push sent',
          data: { type, expiresAt: new Date(Date.now() + 30000).toISOString() } }, 'ExponentPushToken[synthetic]');
        assert.equal(payload.sound, type === 'trip_request' ? 'default' : 'driver_ring.wav', 'WRONG_IOS_SOUND');
        if (type !== 'trip_request' && version === 2) {
          assert.equal(payload.categoryId, 'driver-offer-v2');
          assert.equal(payload.interruptionLevel, 'time-sensitive');
        }
      }
    }
    result.driverPayload = result.broadcastPreserved = true;
  } finally { global.fetch = originalFetch; }
  console.log('ZWANGA_DISPATCH_PREFLIGHT ' + JSON.stringify(result));
}

const timeout = setTimeout(() => { console.error('ZWANGA_DISPATCH_PREFLIGHT_FAILED TIMEOUT'); process.exit(1); }, 45000);
main().then(() => { clearTimeout(timeout); }).catch(error => {
  clearTimeout(timeout);
  // Deliberately omit error messages/stacks: pg/network errors may contain credentials.
  console.error('ZWANGA_DISPATCH_PREFLIGHT_FAILED ' + (error?.code === 'ERR_ASSERTION' ? error.message.split('\n')[0] : 'CHECK_FAILED'));
  process.exitCode = 1;
});
