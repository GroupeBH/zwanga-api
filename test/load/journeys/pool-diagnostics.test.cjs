'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { observePool } = require('./pool-diagnostics.cjs');
test('retains an admission peak even when the queue drains before the next sample', async () => {
  const pool = { totalCount: 10, idleCount: 0, waitingCount: 0,
    connect() { this.waitingCount++; return Promise.resolve('client'); } };
  const snapshot = observePool(pool);
  for (let i = 0; i < 69; i++) assert.equal(await pool.connect(), 'client');
  pool.waitingCount = 0;
  assert.deepEqual(snapshot(), { total: 10, idle: 0, waiting: 0, peakWaiting: 69 });
});
test('preserves pg callback overload, this binding and thrown errors', () => {
  const pool = { totalCount: 1, idleCount: 1, waitingCount: 0,
    connect(cb) { assert.equal(this, pool); if (!cb) throw new Error('failure'); cb(null, 'client'); } };
  const snapshot = observePool(pool);
  let result;
  assert.equal(pool.connect((error, client) => { assert.equal(error, null); result = client; }), undefined);
  assert.equal(result, 'client'); assert.throws(() => pool.connect(), /failure/);
  assert.equal(snapshot().peakWaiting, 0);
});

test('captures leased work at admission before drain, bounded to first and latest peaks', async () => {
  const pool = { totalCount: 10, idleCount: 0, waitingCount: 0,
    connect() { this.waitingCount++; return Promise.resolve('client'); } };
  let calls = 0;
  const snapshot = observePool(pool, { capturePressure: () => ({ active: [{ context: 'worker:test', heldMs: ++calls }] }) });
  for (let i = 0; i < 55; i++) await pool.connect();
  pool.waitingCount = 0;
  const result = snapshot();
  assert.equal(calls, 16);
  assert.deepEqual(result.pressure.map(s => s.waiting), [40, 53, 54, 55]);
  assert.equal(result.pressure[0].evidence.active[0].heldMs, 1);
  result.pressure[0].evidence.active[0].heldMs = 999;
  assert.equal(snapshot().pressure[0].evidence.active[0].heldMs, 1);
  assert.equal(snapshot().peakWaiting, 55);
});

test('diagnostic failure never changes pg results or exposes error details', () => {
  const pool = { totalCount: 10, idleCount: 0, waitingCount: 40,
    connect() { this.waitingCount++; throw new Error('original pg failure'); } };
  const snapshot = observePool(pool, { capturePressure: () => { throw new Error('private detail'); } });
  assert.throws(() => pool.connect(), /original pg failure/);
  assert.deepEqual(snapshot().pressure[0].evidence, { unavailable: true });
  assert.doesNotMatch(JSON.stringify(snapshot()), /private detail/);
});
