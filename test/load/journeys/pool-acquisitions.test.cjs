'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { PoolAcquisitions } = require('./pool-acquisitions.cjs');
const { SqlProfiler } = require('./sql-profiler.cjs');
const { observePool } = require('./pool-diagnostics.cjs');

test('outstanding acquisitions retain bounded contexts and ages, with idempotent cleanup', () => {
  let now = 0; const pending = new PoolAcquisitions({ now: () => now, maxTracked: 2 });
  const first = pending.start('gps'); now = 10;
  const second = pending.start('gps'), overflow = pending.start('response'); now = 25;
  assert.deepEqual(pending.snapshot().groups, [{ context: 'gps', pending: 2, oldestMs: 25 }]);
  assert.equal(pending.snapshot().pending, 3); assert.equal(pending.snapshot().untracked, 1);
  first(); first(); assert.equal(pending.snapshot().groups[0].oldestMs, 15);
  second(); overflow(); overflow(); assert.equal(pending.snapshot().pending, 0);
});
test('pressure capture attributes the acquisition that crosses the threshold and clears errors', async () => {
  const releases = [];
  const pool = { totalCount: 1, idleCount: 0, waitingCount: 0,
    connect() { this.waitingCount++; return new Promise((resolve, reject) => releases.push({ resolve, reject })); } };
  const profiler = new SqlProfiler([]);
  const snapshot = observePool(pool, { pressureThreshold: 1, capturePressure: () => ({ acquisitions: profiler.acquisitions.snapshot() }) });
  const db = { driver: { obtainMasterConnection: () => pool.connect() }, createQueryRunner() {} };
  profiler.install(db);
  const first = profiler.activity('service:respond', () => db.driver.obtainMasterConnection());
  const error = new Error('private connection error');
  const second = profiler.activity('gps', () => db.driver.obtainMasterConnection()).catch(e => e);
  assert.deepEqual(snapshot().pressure[1].evidence.acquisitions.groups.map(g => g.context), ['service:respond', 'gps']);
  releases[0].resolve('client'); releases[1].reject(error); await first; assert.equal(await second, error);
  assert.equal(profiler.snapshot().pendingAcquisitions.pending, 0);
  assert.doesNotMatch(JSON.stringify(profiler.snapshot()), /private connection error/);
});
