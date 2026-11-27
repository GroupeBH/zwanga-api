'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { httpErrorCategory, createHttpAgent } = require('./transport.cjs');
test('HTTP failure diagnostics preserve bounded cause without URLs, headers or error messages', () => {
  const req = { reusedSocket: true, writableFinished: true, path: '/private', headers: { authorization: 'secret' } };
  assert.equal(httpErrorCategory({ code: 'ECONNRESET', message: 'secret' }, req, false), 'ECONNRESET; reused=true; finished=true');
  assert.equal(httpErrorCategory({ code: 'secret' }, req, false), 'unknown; reused=true; finished=true');
  assert.equal(httpErrorCategory({}, {}, true), 'deadline; reused=false; finished=false');
});
test('idle keep-alive expires before the server hint without raising the request budget', () => {
  const agent = createHttpAgent();
  const socket = { timeout: 0, setKeepAlive() {}, unref() {}, setTimeout(ms) { this.timeout = ms; },
    _httpMessage: { res: { headers: { 'keep-alive': 'timeout=5' } } } };
  try {
    assert.equal(agent.options.timeout, 5000); assert.equal(agent.maxSockets, 32);
    assert.equal(agent.keepSocketAlive(socket), true);
    assert.ok(socket.timeout > 0 && socket.timeout < 5000);
  } finally { agent.destroy(); }
});
