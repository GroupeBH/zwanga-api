'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { once } = require('node:events');
const { restrictConnections, minimalEnvironment } = require('./isolation.cjs');

test('backend egress is restricted to explicitly leased loopback ports', async () => {
  const server = net.createServer(socket => socket.end());
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const guard = restrictConnections([port]);
  try {
    for (const options of [
      { host: 'example.com', port: 443 },
      { host: '169.254.169.254', port: 80 },
      { host: '127.0.0.1', port: port === 1 ? 2 : 1 },
      { host: 'localhost', port }, // no DNS/hosts-file ambiguity
      { path: '/tmp/a-socket' },
    ]) {
      assert.throws(() => net.connect(options), { code: 'LOAD_TEST_EXTERNAL_CONNECTION_BLOCKED' });
    }
    for (const connect of [
      () => net.connect({ host: '127.0.0.1', port }),
      () => new net.Socket().connect(port, '127.0.0.1'),
    ]) {
      const client = connect(); await once(client, 'connect'); client.destroy();
    }
    assert.equal(guard.count(), 5);
  } finally { guard.restore(); await new Promise(resolve => server.close(resolve)); }
});

test('child environment does not inherit provider credentials or connection strings', () => {
  const env = minimalEnvironment();
  assert.ok(Object.keys(env).every(key => ['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP', 'TMPDIR'].includes(key)));
  assert.equal(env.DATABASE_URL, undefined);
  assert.equal(env.AWS_PROFILE, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(minimalEnvironment({ ZWANGA_ISOLATED_LOAD: '1' }).ZWANGA_ISOLATED_LOAD, '1');
});
