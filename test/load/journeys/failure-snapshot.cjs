'use strict';
const { performance } = require('node:perf_hooks');

// Diagnostics must neither hide the first safety failure nor keep a run alive.
// No arbitrary error text: it could contain SQL, URLs or payloads.
async function captureSnapshot(read, timeoutMs = 17000) {
  const requestedAt = new Date().toISOString(), started = performance.now();
  let timer;
  try {
    const result = await Promise.race([
      Promise.resolve().then(read).then(sample => ({ status: 'captured', sample }), () => ({ status: 'unavailable' })),
      new Promise(resolve => { timer = setTimeout(() => resolve({ status: 'timeout' }), timeoutMs); }),
    ]);
    return { requestedAt, completedAt: new Date().toISOString(), durationMs: performance.now() - started, ...result };
  } finally { clearTimeout(timer); }
}

function firstFailureSnapshot(read, context, timeoutMs) {
  let pending;
  return () => {
    if (!pending) {
      const atFailure = context();
      pending = captureSnapshot(read, timeoutMs).then(snapshot => ({ ...snapshot, atFailure }));
    }
    return pending;
  };
}
module.exports = { captureSnapshot, firstFailureSnapshot };
