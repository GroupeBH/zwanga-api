'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { whileScheduling } = require('./cooperative-wait.cjs');

test('slow preparation does not suspend scheduled GPS ticks or duplicate preparation', async () => {
  let complete, ticks = 0, calls = 0;
  const operation = new Promise(resolve => { complete = resolve; });
  const result = await whileScheduling(() => { calls++; return operation; }, async () => {
    ticks++; if (ticks === 5) complete('ready');
  });
  assert.equal(result, 'ready'); assert.equal(calls, 1); assert.ok(ticks >= 5);
});

test('preparation failure is preserved, including a non-Error rejection', async () => {
  const failure = new Error('HTTP deadline');
  await assert.rejects(whileScheduling(() => Promise.reject(failure), async () => {}), e => e === failure);
  let caught = false;
  try { await whileScheduling(() => Promise.reject(undefined), async () => {}); } catch { caught = true; }
  assert.equal(caught, true);
});

test('scheduler safety failure propagates after observing preparation completion', async () => {
  const failure = new Error('in-flight ceiling'); let settled = false;
  await assert.rejects(whileScheduling(async () => { await Promise.resolve(); settled = true; },
    async () => { throw failure; }), e => e === failure);
  assert.equal(settled, true);
});
