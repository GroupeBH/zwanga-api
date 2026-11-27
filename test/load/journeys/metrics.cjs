'use strict';

// Fixed-memory latency histograms: no token, payload, identifier or per-GPS row retained.
const BOUNDS = [5, 10, 20, 50, 100, 200, 300, 500, 750, 1000, 1500, 2000, 3000, 5000, 10000];
class Metrics {
  constructor() { this.groups = new Map(); }
  record(name, ms, ok = true) {
    if (!Number.isFinite(ms) || ms < 0) throw new Error('Invalid observation');
    const g = this.groups.get(name) || { count: 0, failed: 0, sumMs: 0, maxMs: 0, buckets: BOUNDS.map(() => 0), overflow: 0 };
    g.count++; g.failed += !ok; g.sumMs += ms; g.maxMs = Math.max(g.maxMs, ms);
    const i = BOUNDS.findIndex(b => ms <= b);
    if (i < 0) g.overflow++; else g.buckets[i]++;
    this.groups.set(name, g);
  }
  snapshot() {
    return Object.fromEntries([...this.groups].map(([name, g]) => {
      const percentile = q => { let n = 0; for (let i = 0; i < BOUNDS.length; i++) {
        n += g.buckets[i]; if (n >= Math.ceil(g.count * q)) return BOUNDS[i];
      } return null; };
      return [name, { count: g.count, failed: g.failed, meanMs: g.sumMs / g.count,
        maxMs: g.maxMs, p95UpperBoundMs: percentile(.95), p99UpperBoundMs: percentile(.99) }];
    }));
  }
}

// An open-loop schedule does not wait for responses to decide the next due time.
// Refuse lag beyond the tolerance, without resetting deadlines. Multiple due
// ticks within that tolerance still obey the separate in-flight admission cap.
function dueWork(now, next, maxLagMs) {
  if (now < next) return false;
  if (now - next > maxLagMs) throw new Error('Generator schedule lag; throughput not achieved');
  return true;
}

// Include rejected work and all offered workload types, not only GPS ticks
// that already passed admission. Never retain a user, trip or request id.
class ScheduleDiagnostics {
  constructor(limitMs) { this.limitMs = limitMs; this.lags = {}; this.rejected = null; }
  due(kind, now, next) {
    if (!['gps', 'request', 'available_driver_position'].includes(kind)) throw new Error('Unknown schedule kind');
    const lagMs = Math.max(0, now - next);
    this.lags[kind] = Math.max(this.lags[kind] || 0, lagMs);
    try { return dueWork(now, next, this.limitMs); }
    catch (error) { this.rejected ||= { kind, lagMs, limitMs: this.limitMs }; throw error; }
  }
  snapshot() {
    return { maxLagMs: Math.max(0, ...Object.values(this.lags)), scheduleLagByOperationMs: { ...this.lags },
      ...(this.rejected ? { scheduleRejected: { ...this.rejected } } : {}) };
  }
}

// Keep the latest full SQL profile in lastHealth. Historical snapshots need
// cumulative totals, not another copy of every query family every five seconds.
function healthSummary(sample) {
  return { ...sample, servers: sample.servers.map(({ sqlProfile, ...server }) => ({ ...server,
    ...(sqlProfile ? { sqlTotals: sqlProfile.queries.reduce((totals, row) => {
      for (const key of ['count', 'failed', 'totalMs', 'connectMs']) totals[key] += row[key];
      return totals;
    }, { count: 0, failed: 0, totalMs: 0, connectMs: 0, overflowQueries: sqlProfile.overflowQueries }) } : {}),
  })) };
}
module.exports = { Metrics, dueWork, ScheduleDiagnostics, healthSummary };
