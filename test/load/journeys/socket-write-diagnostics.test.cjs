'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { observeSocketWrites } = require('./socket-write-diagnostics.cjs');

test('write observation preserves callbacks, receiver, return values and thrown failures', () => {
  let time = 0, call;
  const failure = new Error('not exported');
  const prototype = { _write(...args) { call = { receiver: this, args }; time += 35; return 42; },
    _writev() { time += 50; throw failure; } };
  const original = prototype._write;
  const observer = observeSocketWrites(prototype, { postgresPort: 1111, redisPort: 2222, now: () => time });
  const socket = Object.assign(Object.create(prototype), { remotePort: 1111 });
  const callback = () => {}, payload = Buffer.from('private');
  assert.equal(socket._write(payload, 'buffer', callback), 42);
  assert.equal(call.receiver, socket); assert.deepEqual(call.args, [payload, 'buffer', callback]);
  assert.throws(() => socket._writev([], callback), e => e === failure);
  const snapshot = observer.snapshot();
  assert.equal(snapshot.groups[0].maxMs, 35); assert.equal(snapshot.groups[1].threw, 1);
  assert.equal(snapshot.longest[0].durationMs, 50); assert.equal(snapshot.longest[0].target, 'postgres');
  for (const text of ['1111', '2222', 'private', 'not exported']) assert.ok(!JSON.stringify(snapshot).includes(text));
  observer.stop(); observer.stop(); assert.equal(prototype._write, original);
});

test('socket diagnostics bound categories and retained incidents without sampling callback time', () => {
  let time = 0;
  const prototype = { _write() { time += 25; }, _writev() {} };
  const observer = observeSocketWrites(prototype, { postgresPort: 1111, redisPort: 2222, now: () => time });
  for (let i = 0; i < 100; i++) prototype._write.call({ remotePort: 3000 + i });
  assert.equal(observer.snapshot().groups.length, 1);
  assert.equal(observer.snapshot().longest.length, 12);
  assert.equal(observer.snapshot().groups[0].calls, 100);
  const previous = observer.snapshot(); time += 1000;
  assert.deepEqual(observer.snapshot(), previous);
  observer.stop();
});
