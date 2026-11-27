'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ConnectionOccupancy } = require('./connection-occupancy.cjs');
const shape = { id: 'opaque', operation: 'SELECT', tables: ['bookings'] };

test('occupancy excludes pool wait, counts between-query time and releases once', () => {
  let now = 0; const d = new ConnectionOccupancy({ now: () => now }), r = d.runner();
  const begin = r.query(shape, 'transaction-owner', { begin: true });
  now = 7; r.connected('owner'); now = 10; begin(true);
  now = 20; const work = r.query(shape, 'nested'); now = 25; work(true);
  now = 30; const end = r.query(shape, 'nested', { end: 'commit' }); now = 32; end(true);
  now = 35; r.released(); r.released();
  const s = d.snapshot(), lease = s.groups.find(g => g.kind === 'lease'), tx = s.groups.find(g => g.kind === 'transaction');
  assert.deepEqual([lease.totalMs, lease.queryBusyMs, lease.betweenQueriesMs, lease.queries], [28, 10, 18, 3]);
  assert.deepEqual([tx.context, tx.totalMs, tx.queryBusyMs, tx.queries, tx.outcomes.commit], ['transaction-owner', 25, 10, 3, 1]);
  assert.equal(s.active.length, 0); assert.equal(lease.count, 1);
});

test('query time is a union when calls overlap on one leased connection', () => {
  let now = 0; const d = new ConnectionOccupancy({ now: () => now }), r = d.runner(); r.connected('owner');
  now = 2; const a = r.query(shape, 'a'); now = 4; const b = r.query(shape, 'b');
  now = 7; a(true); now = 10; b(false); now = 12; r.released();
  assert.equal(d.snapshot().groups[0].queryBusyMs, 8);
  assert.equal(d.snapshot().groups[0].betweenQueriesMs, 4);
});

test('failed commit leaves transaction open until rollback and missing release remains visible', () => {
  let now = 0; const d = new ConnectionOccupancy({ now: () => now }), r = d.runner(); r.connected('owner');
  r.query(shape, 'owner', { begin: true })(true); now = 3;
  r.query(shape, 'other', { end: 'commit' })(false); now = 10;
  assert.equal(d.snapshot().active[0].transactionContext, 'owner');
  assert.equal(d.snapshot().active[0].transactionMs, 10);
  r.query(shape, 'other', { end: 'rollback' })(true); r.released(true);
  assert.deepEqual(d.snapshot().groups.find(g => g.kind === 'transaction').outcomes, { rollback: 1 });
  assert.deepEqual(d.snapshot().groups.find(g => g.kind === 'lease').outcomes, { broken: 1 });
});

test('diagnostic active storage and group storage remain bounded', () => {
  const d = new ConnectionOccupancy({ maxActive: 2, maxGroups: 2 });
  const runners = Array.from({ length: 20 }, (_, i) => { const r = d.runner(); r.connected(`owner${i}`); return r; });
  assert.equal(d.snapshot().active.length, 2); assert.equal(d.snapshot().untrackedLeases, 18);
  runners.forEach(r => r.released()); assert.ok(d.snapshot().groups.length <= 4); assert.equal(d.snapshot().active.length, 0);
});

test('pressure snapshots expose active query duration without traversing completed groups', () => {
  let now = 0; const d = new ConnectionOccupancy({ now: () => now }), r = d.runner();
  r.connected('owner'); now = 10; const end = r.query(shape, 'owner'); now = 25;
  const first = d.activeSnapshot();
  assert.equal(first.active[0].heldMs, 25);
  assert.equal(first.active[0].queryActiveMs, 15);
  end(true); now = 30;
  assert.equal(d.activeSnapshot().active[0].queryActiveMs, 0);
  assert.equal(first.active[0].queryActiveMs, 15);
  assert.equal(Object.hasOwn(first, 'groups'), false);
  r.released(); assert.equal(d.activeSnapshot().active.length, 0);
});
