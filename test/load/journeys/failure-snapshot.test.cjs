'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { captureSnapshot, firstFailureSnapshot } = require('./failure-snapshot.cjs');

test('first failure captures immediately, once, before pending work drains', async () => {
  let inflight = 128, reads = 0, complete;
  const snapshot = firstFailureSnapshot(() => { reads++; return new Promise(resolve => { complete = resolve; }); },
    () => ({ inflight }), 1000);
  const first = snapshot(); inflight = 0;
  assert.equal(snapshot(), first);
  await Promise.resolve(); assert.equal(reads, 1);
  complete({ queue: 42 });
  const result = await first;
  assert.equal(result.status, 'captured'); assert.equal(result.atFailure.inflight, 128);
  assert.deepEqual(result.sample, { queue: 42 });
  assert.ok(Date.parse(result.completedAt) >= Date.parse(result.requestedAt));
});

test('metrics failure does not escape or expose error content', async () => {
  const result = await captureSnapshot(() => { throw new Error('secret query'); });
  assert.equal(result.status, 'unavailable');
  assert.ok(!JSON.stringify(result).includes('secret'));
});

test('a stuck capture is bounded and late rejection remains handled', async () => {
  let reject;
  const result = await captureSnapshot(() => new Promise((_, no) => { reject = no; }), 5);
  assert.equal(result.status, 'timeout');
  reject(new Error('late private error'));
  await new Promise(resolve => setImmediate(resolve));
});
