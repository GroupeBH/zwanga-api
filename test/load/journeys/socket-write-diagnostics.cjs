'use strict';
const { performance } = require('node:perf_hooks');

// Local-only observation of synchronous socket write submission, NOT network
// delivery or callback latency. Keep payloads, addresses and ports out of output.
function observeSocketWrites(prototype, { postgresPort, redisPort, now = () => performance.now() }) {
  const groups = new Map(), longest = [], originals = new Map();
  const category = socket => socket.remotePort === postgresPort ? 'postgres'
    : socket.remotePort === redisPort ? 'redis' : socket.remotePort ? 'client' : 'other';
  for (const name of ['_write', '_writev']) {
    const original = prototype[name];
    if (typeof original !== 'function') throw new Error('Socket write observation unavailable');
    originals.set(name, original);
    prototype[name] = function (...args) {
      const target = category(this), start = now(); let failed = true;
      try { const value = original.apply(this, args); failed = false; return value; }
      finally {
        const ms = Math.max(0, now() - start), key = `${target}:${name}`;
        const row = groups.get(key) ?? { target, method: name, calls: 0, threw: 0, totalMs: 0, maxMs: 0 };
        row.calls++; row.threw += failed; row.totalMs += ms; row.maxMs = Math.max(row.maxMs, ms); groups.set(key, row);
        if (ms >= 20) {
          longest.push({ atMs: start, durationMs: ms, target, method: name });
          longest.sort((a, b) => b.durationMs - a.durationMs); longest.length = Math.min(longest.length, 12);
        }
      }
    };
  }
  return {
    snapshot: () => ({ semantics: 'synchronous write submission wall time, not delivery latency; process-relative timestamps',
      groups: [...groups.values()].map(row => ({ ...row })), longest: longest.map(row => ({ ...row })) }),
    stop: () => { for (const [name, original] of originals) prototype[name] = original; originals.clear(); },
  };
}
module.exports = { observeSocketWrites };
