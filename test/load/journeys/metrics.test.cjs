'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ScheduleDiagnostics, healthSummary } = require('./metrics.cjs');

test('schedule diagnostics include the rejected lag without relaxing the existing boundary', () => {
  const s = new ScheduleDiagnostics(1000);
  assert.equal(s.due('gps', 99, 100), false);
  assert.equal(s.due('gps', 1100, 100), true);
  assert.throws(() => s.due('gps', 1101, 100), /schedule lag/);
  assert.deepEqual(s.snapshot(), { maxLagMs: 1001, scheduleLagByOperationMs: { gps: 1001 },
    scheduleRejected: { kind: 'gps', lagMs: 1001, limitMs: 1000 } });
});

test('request and available-driver delays are recorded independently with no identifiers', () => {
  const s = new ScheduleDiagnostics(1000);
  s.due('gps', 100, 90); s.due('request', 600, 100);
  assert.throws(() => s.due('available_driver_position', 1200, 100), /schedule lag/);
  assert.equal(s.snapshot().maxLagMs, 1100);
  assert.deepEqual(s.snapshot().scheduleLagByOperationMs, { gps: 10, request: 500, available_driver_position: 1100 });
  assert.throws(() => s.due('private-user-id', 1200, 100), /Unknown/);
  const snap = s.snapshot(); snap.scheduleLagByOperationMs.gps = -1;
  snap.scheduleRejected.lagMs = -1;
  assert.equal(s.snapshot().scheduleLagByOperationMs.gps, 10);
  assert.equal(s.snapshot().scheduleRejected.lagMs, 1100);
});

test('health history keeps gates and SQL totals without duplicating or mutating full profiles', () => {
  const profile = { overflowQueries: 2, queries: [
    { count: 3, failed: 0, totalMs: 12, connectMs: 4 },
    { count: 7, failed: 1, totalMs: 20, connectMs: 6 },
  ] };
  const sample = { queue: { pending: 42, oldestSeconds: 0.4 }, evictions: 0,
    servers: [{ peakPoolWaiting: 47, sqlErrors: 1, workerErrors: 0, sqlProfile: profile }] };
  const summary = healthSummary(sample);
  assert.deepEqual(summary, { queue: sample.queue, evictions: 0, servers: [{ peakPoolWaiting: 47,
    sqlErrors: 1, workerErrors: 0, sqlTotals: { count: 10, failed: 1, totalMs: 32, connectMs: 10, overflowQueries: 2 } }] });
  assert.equal(sample.servers[0].sqlProfile, profile);
  assert.equal(profile.queries.length, 2);
  const withoutProfile = { servers: [{ peakPoolWaiting: 0 }] };
  assert.deepEqual(healthSummary(withoutProfile), withoutProfile);
});
