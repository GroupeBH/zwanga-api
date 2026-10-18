'use strict';

const net = require('node:net');

// Installed before importing application modules. Never allows DNS resolution,
// arbitrary local services, remote TCP, or Unix sockets/named pipes.
function restrictConnections(ports) {
  const allowed = new Set(ports.map(Number));
  const original = net.Socket.prototype.connect;
  let blocked = 0;
  net.Socket.prototype.connect = function (...args) {
    // net.connect() passes an already-normalized argument array on Node 24;
    // pg also calls socket.connect(options) directly.
    const normalized = Array.isArray(args[0]) ? args[0][0] : net._normalizeArgs(args)[0];
    if (!['127.0.0.1', '::1'].includes(normalized.host) ||
        !allowed.has(Number(normalized.port)) || normalized.path) {
      blocked++;
      const error = new Error('LOAD_TEST_EXTERNAL_CONNECTION_BLOCKED');
      error.code = 'LOAD_TEST_EXTERNAL_CONNECTION_BLOCKED';
      throw error;
    }
    return original.apply(this, args);
  };
  return { count: () => blocked, restore: () => { net.Socket.prototype.connect = original; } };
}

function minimalEnvironment(extra = {}) {
  const env = {};
  for (const key of ['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP', 'TMPDIR']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return { ...env, ...extra };
}

module.exports = { restrictConnections, minimalEnvironment };
