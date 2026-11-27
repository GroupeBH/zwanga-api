'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { InFlightBudget } = require('./inflight-budget.cjs');

test('GPS pair admission is all or nothing and preserves the unchanged ceiling', () => {
  const budget = new InFlightBudget(3, () => 0);
  const [receipt] = budget.reserve(['alert_receipt']);
  const [request] = budget.reserve(['request_create']);
  assert.throws(() => budget.reserve(['driver_operation', 'passenger_operation']), /in-flight ceiling/);
  assert.equal(budget.active.size, 2);
  assert.equal(budget.peak, 2);
  budget.release(receipt);
  const pair = budget.reserve(['driver_operation', 'passenger_operation']);
  assert.equal(budget.peak, 3);
  [request, ...pair].forEach(token => budget.release(token));
  assert.deepEqual(budget.snapshot(), { total: 0, byKind: {} });
});

test('stop evidence keeps counts and ages per operation even after pending work drains', () => {
  let now = 100;
  const budget = new InFlightBudget(3, () => now);
  const [gps] = budget.reserve(['driver_operation']);
  now = 200;
  const receipts = budget.reserve(['alert_receipt', 'alert_receipt']);
  now = 350;
  assert.throws(() => budget.reserve(['request_create']), /in-flight ceiling/);
  assert.deepEqual(budget.rejected, { limit: 3, requested: ['request_create'], total: 3,
    byKind: { driver_operation: { count: 1, oldestMs: 250 }, alert_receipt: { count: 2, oldestMs: 150 } } });
  const evidence = JSON.stringify(budget.rejected);
  [gps, ...receipts].forEach(token => budget.release(token));
  assert.equal(JSON.stringify(budget.rejected), evidence);
  budget.release(gps); // A late finally cannot release someone else's reservation.
  assert.equal(budget.active.size, 0);
});

test('telemetry rejects arbitrary labels and cannot retain an external payload', () => {
  const budget = new InFlightBudget(1);
  assert.throws(() => budget.reserve(['https://private/token']), /Unknown generator operation/);
  assert.throws(() => budget.reserve([]), /Unknown generator operation/);
  assert.equal(budget.active.size, 0);
  assert.equal(budget.rejected, undefined);
});

test('presence preparation shares the same admission budget as GPS without increasing it', () => {
  const budget = new InFlightBudget(128);
  const [presence] = budget.reserve(['available_driver_presence']);
  const pairs = [];
  for (let i = 0; i < 63; i++) pairs.push(...budget.reserve(['driver_operation', 'passenger_operation']));
  assert.equal(budget.active.size, 127);
  assert.throws(() => budget.reserve(['driver_operation', 'passenger_operation']), /in-flight ceiling/);
  assert.equal(budget.rejected.byKind.available_driver_presence.count, 1);
  [presence, ...pairs].forEach(token => budget.release(token));
  assert.equal(budget.active.size, 0);
});
