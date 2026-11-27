'use strict';

// Await a bounded preparation operation while the existing open-loop scheduler
// keeps running. Never change its deadlines, pace, admission or failure gates.
async function whileScheduling(operation, tick) {
  let done = false, value, error, rejected = false;
  const pending = Promise.resolve().then(operation).then(result => { value = result; }, reason => {
    rejected = true; error = reason;
  }).finally(() => { done = true; });
  try {
    while (!done) await tick();
    if (rejected) throw error;
    return value;
  } finally {
    // Observe completion even when a safety gate fails; the operation must have
    // its own deadline (the local HTTP client does). No detached background work.
    await pending;
  }
}
module.exports = { whileScheduling };
