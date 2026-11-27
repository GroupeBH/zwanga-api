'use strict';
const { performance } = require('node:perf_hooks');

// Bench-only outstanding acquisitions, including connection establishment. The
// real pool.waitingCount remains authoritative for the actual pg waiting queue.
// Labels come from the profiler's bounded static contexts, never request data.
class PoolAcquisitions {
  constructor({ now = () => performance.now(), maxTracked = 1024 } = {}) {
    this.now = now; this.maxTracked = maxTracked; this.pending = new Map(); this.untracked = 0;
  }
  start(context) {
    let done = false;
    if (this.pending.size >= this.maxTracked) {
      this.untracked++;
      return () => { if (!done) { done = true; this.untracked--; } };
    }
    const token = {}, at = this.now(); this.pending.set(token, { context, at });
    return () => { if (!done) { done = true; this.pending.delete(token); } };
  }
  snapshot() {
    const now = this.now(), groups = new Map();
    for (const { context, at } of this.pending.values()) {
      const group = groups.get(context) ?? { context, pending: 0, oldestMs: 0 };
      group.pending++; group.oldestMs = Math.max(group.oldestMs, now - at); groups.set(context, group);
    }
    return { pending: this.pending.size + this.untracked, untracked: this.untracked, groups: [...groups.values()],
      semantics: 'outstanding pool acquisitions, including establishment and callback scheduling; not SQL execution' };
  }
}
module.exports = { PoolAcquisitions };
