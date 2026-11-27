'use strict';
const { performance } = require('node:perf_hooks');

const KINDS = new Set(['driver_operation', 'passenger_operation', 'request_create',
  'alert_receipt', 'available_driver_position', 'available_driver_presence', 'request_cancel', 'dispatch_response']);

// Only operation names and ages, never JWTs, URLs, payloads or participant IDs.
// Reserve a GPS pair before either send, keeping overload counters truthful.
class InFlightBudget {
  constructor(limit, now = () => performance.now()) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('Invalid in-flight limit');
    this.limit = limit; this.now = now; this.active = new Map(); this.peak = 0;
  }
  reserve(kinds) {
    if (!Array.isArray(kinds) || !kinds.length || kinds.some(kind => !KINDS.has(kind)))
      throw new Error('Unknown generator operation');
    const now = this.now();
    if (this.active.size + kinds.length > this.limit) {
      this.rejected ||= { limit: this.limit, requested: [...kinds], ...this.snapshot(now) };
      throw new Error('Generator in-flight ceiling; target rate not achieved');
    }
    const tokens = kinds.map(kind => {
      const token = Symbol(kind); this.active.set(token, { kind, started: now }); return token;
    });
    this.peak = Math.max(this.peak, this.active.size);
    return tokens;
  }
  release(token) { this.active.delete(token); }
  snapshot(now = this.now()) {
    const byKind = {};
    for (const { kind, started } of this.active.values()) {
      const group = byKind[kind] ||= { count: 0, oldestMs: 0 };
      group.count++; group.oldestMs = Math.max(group.oldestMs, Math.max(0, now - started));
    }
    return { total: this.active.size, byKind };
  }
}
module.exports = { InFlightBudget };
