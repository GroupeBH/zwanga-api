'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { stopOwnedBackend } = require('./stop-owned-backend.cjs');
function backend(t) {
  const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, connected: true });
  child.send = t.mock.fn(); child.kill = t.mock.fn(); return child;
}
test('owned backend has time to drain workers plus the 10s tracking reconnect window', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const child = backend(t), stopped = stopOwnedBackend(child);
  assert.deepEqual(child.send.mock.calls[0].arguments[0], { type: 'stop' });
  t.mock.timers.tick(20000); assert.equal(child.kill.mock.callCount(), 0);
  child.emit('exit', 0); assert.equal(await stopped, null);
  t.mock.timers.tick(30000); assert.equal(child.kill.mock.callCount(), 0);
});
test('forced stop remains reported and waits for owned child exit before database cleanup', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const child = backend(t); let completed = false;
  const stopped = stopOwnedBackend(child).then(value => { completed = true; return value; });
  t.mock.timers.tick(30000); await Promise.resolve();
  assert.deepEqual(child.kill.mock.calls[0].arguments, ['SIGKILL']); assert.equal(completed, false);
  child.emit('exit', null, 'SIGKILL'); assert.equal(await stopped, 'backend forced stop');
});
test('a child that never exits fails within a bounded deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const child = backend(t), stopped = stopOwnedBackend(child);
  const rejected = assert.rejects(stopped, /did not exit/);
  t.mock.timers.tick(30000); t.mock.timers.tick(5000); await rejected;
  assert.equal(child.listenerCount('exit'), 0);
});
test('already stopped children are never killed again', async t => {
  const child = backend(t); child.exitCode = 0;
  assert.equal(await stopOwnedBackend(child), null);
  assert.equal(child.kill.mock.callCount(), 0); assert.equal(child.send.mock.callCount(), 0);
});
