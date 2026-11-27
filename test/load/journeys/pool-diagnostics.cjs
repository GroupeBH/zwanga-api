'use strict';

// Observe the actual queue admission, not only a 100ms timer that may be delayed
// by the same event-loop stall we are trying to diagnose. Preserve pg overloads.
function observePool(pool, { capturePressure, pressureThreshold = 40 } = {}) {
  const connect = pool.connect;
  let peakWaiting = pool.waitingCount;
  const pressure = [];
  let capturedWaiting = pressureThreshold - 1;
  const observe = () => {
    peakWaiting = Math.max(peakWaiting, pool.waitingCount);
    if (!capturePressure || pool.waitingCount < pressureThreshold || pool.waitingCount <= capturedWaiting) return;
    capturedWaiting = pool.waitingCount;
    // No SQL and no async sampling here: preserve the leased work at admission,
    // before a busy API drains its queue and replies to the next metrics timer.
    // Keep the first crossing and the three latest peaks, never all admissions.
    let evidence;
    try { evidence = capturePressure(); }
    catch { evidence = { unavailable: true }; }
    const sample = { sampledAt: new Date().toISOString(), waiting: pool.waitingCount,
      total: pool.totalCount, idle: pool.idleCount, evidence };
    if (pressure.length === 4) pressure.splice(1, 1);
    pressure.push(sample);
  };
  pool.connect = function (...args) {
    try { return connect.apply(this, args); }
    finally { observe(); }
  };
  return () => {
    observe();
    return { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount, peakWaiting,
      ...(capturePressure ? { pressure: structuredClone(pressure) } : {}) };
  };
}
module.exports = { observePool };
