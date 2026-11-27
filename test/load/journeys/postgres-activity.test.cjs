'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { summarizeActivity, postgresActivity } = require('./postgres-activity.cjs');
test('profiling includes the raw SQL ringing and retry tables as well as ORM entities', () => {
  const { profiledTables } = require('./profiled-tables.cjs');
  const tables = profiledTables({ entityMetadatas: [{ tableName: 'users' }] });
  for (const table of ['users', 'nearby_driver_ring_state', 'nearby_driver_ring_events', 'ride_notification_retries', 'maintenance_job_leases'])
    assert.ok(tables.includes(table));
});
test('blocking sample groups safe query descriptors without exporting SQL, data or PIDs', () => {
  const base = { queryBytes: 1024, totalConnections: 3, activeMs: 20, transactionMs: 80 };
  const sample = summarizeActivity([
    { ...base, pid: 10101, state: 'active', waitType: 'Lock', waitEvent: 'transactionid', blockers: [20202, 20202], query: 'UPDATE bookings SET status=$1 WHERE id=$2' },
    { ...base, pid: 20202, state: 'idle in transaction', waitType: 'Client', waitEvent: 'ClientRead', blockers: [], activeMs: 0, query: "SELECT * FROM users WHERE phone='private-value' -- private-comment" },
    { ...base, pid: 30303, state: 'active', waitType: 'Lock', waitEvent: 'tuple', blockers: [40404], query: 'UPDATE bookings SET status=$1 WHERE id=$2' },
  ], ['bookings', 'users']);
  assert.equal(sample.blocking.length, 2); assert.equal(sample.blocking[0].links, 1);
  assert.deepEqual(sample.blocking[0].waitingQuery.tables, ['bookings']);
  assert.deepEqual(sample.blocking[0].blockingQuery.tables, ['users']);
  assert.equal(sample.blocking[1].blockerState, 'outside-sample');
  for (const value of ['private-value', 'private-comment', '10101', '20202', '30303', '40404', 'SET status', 'WHERE phone'])
    assert.ok(!JSON.stringify(sample).includes(value));
});
test('truncation and incomplete samples are explicit', () => {
  const r = summarizeActivity([{ pid: 1, state: 'active', waitType: null, waitEvent: null,
    query: 'SELECT ' + 'a'.repeat(1016), queryBytes: 1024, blockers: [], activeMs: 1, transactionMs: 2, totalConnections: 90 }], []);
  assert.equal(r.truncatedConnections, 89); assert.equal(r.queryFamilies[0].query.possiblyTruncated, true);
});

test('identical SQL on different replicas stays distinguishable, including blocking edges', () => {
  const base = { queryBytes: 1024, totalConnections: 2, activeMs: 10, transactionMs: 20,
    state: 'active', waitType: 'Lock', waitEvent: 'transactionid', query: 'SELECT * FROM bookings FOR UPDATE' };
  const sample = summarizeActivity([
    { ...base, applicationName: 'zwanga-journey-api-1', pid: 1, blockers: [2] },
    { ...base, applicationName: 'zwanga-journey-api-2', pid: 2, blockers: [] },
  ], ['bookings']);
  assert.deepEqual(sample.groups.map(g => g.replica), [1, 2]);
  assert.equal(sample.queryFamilies.length, 2);
  assert.equal(sample.blocking[0].waitingReplica, 1); assert.equal(sample.blocking[0].blockingReplica, 2);
});
test('blocking inspection is opt-in and keeps the unprofiled observation unchanged', async () => {
  const queries = [], db = { entityMetadatas: [], query: async sql => { queries.push(sql); return []; } };
  assert.deepEqual((await postgresActivity(db)).groups, []);
  assert.ok(!queries[0].includes('pg_blocking_pids'));
  assert.deepEqual((await postgresActivity(db, { detailed: true })).blocking, []);
  assert.ok(queries[1].includes('FROM pg_stat_wal')); assert.ok(queries[1].includes('FROM pg_stat_io'));
  assert.ok(queries[2].includes("wait_event_type='Lock'")); assert.ok(queries[2].includes('LIMIT 64'));
});
