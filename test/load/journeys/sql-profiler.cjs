'use strict';
const { AsyncLocalStorage } = require('node:async_hooks');
const { createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');

// Bench-only. Never emit SQL text, bind values, identifiers from data or errors.
// Cardinalities and the SQL-shape cache are bounded independently of run length.
class SqlProfiler {
  constructor(tables, { maxGroups = 512, now = () => performance.now() } = {}) {
    this.tables = new Set(tables); this.maxGroups = maxGroups; this.now = now;
    this.context = new AsyncLocalStorage(); this.shapes = new Map(); this.groups = new Map();
    this.activities = new Map(); this.pool = new Map(); this.overflowQueries = 0;
    this.acquisitions = new (require('./pool-acquisitions.cjs').PoolAcquisitions)({ now });
    this.occupancy = new (require('./connection-occupancy.cjs').ConnectionOccupancy)({ now });
  }
  shape(sql) {
    // Hash raw text for a bounded lookup, normalize only on a cache miss.
    // Neither the cache nor the report retains SQL text or bind values.
    const cacheKey = createHash('sha256').update(String(sql)).digest('hex');
    if (this.shapes.has(cacheKey)) return this.shapes.get(cacheKey);
    const normalized = String(sql).replace(/'(?:''|[^'])*'/g, '?')
      .replace(/\/\*[\s\S]*?\*\/|--[^\r\n]*/g, ' ')
      .replace(/\$\d+|\b\d+(?:\.\d+)?\b/g, '?').replace(/\s+/g, ' ').trim();
    const id = createHash('sha256').update(normalized).digest('hex').slice(0, 16);
    const operation = /^(SELECT|INSERT|UPDATE|DELETE|WITH|START|COMMIT|ROLLBACK|SET)\b/i.exec(normalized)?.[1].toUpperCase() ?? 'OTHER';
    const tables = [...new Set([...normalized.matchAll(/\b(?:FROM|JOIN|INTO|UPDATE)\s+"?([a-z_][a-z_0-9]*)"?/gi)]
      .map(m => m[1]).filter(t => this.tables.has(t)))].sort();
    const shape = { id, operation, tables };
    if (this.shapes.size < 256) this.shapes.set(cacheKey, shape);
    return shape;
  }
  async activity(label, fn) {
    if (!this.activities.has(label) && this.activities.size >= 64) label = 'other';
    const row = this.activities.get(label) ?? { count: 0, failed: 0, totalMs: 0, maxMs: 0, active: 0, peakActive: 0 };
    this.activities.set(label, row); row.active++; row.peakActive = Math.max(row.peakActive, row.active);
    const start = this.now(); let ok = false;
    try { const value = await this.context.run({ label }, fn); ok = true; return value; }
    finally { const ms = this.now() - start; row.active--; row.count++; row.failed += !ok; row.totalMs += ms; row.maxMs = Math.max(row.maxMs, ms); }
  }
  wrapMethod(instance, method, label) {
    const original = instance[method], profiler = this;
    if (typeof original !== 'function') throw new Error('Missing profiled method');
    instance[method] = function (...args) { return profiler.activity(label, () => original.apply(this, args)); };
  }
  install(db) {
    const profiler = this, createRunner = db.createQueryRunner;
    const obtain = db.driver.obtainMasterConnection;
    db.driver.obtainMasterConnection = async function (...args) {
      const label = profiler.context.getStore()?.label ?? 'unattributed';
      const key = profiler.pool.has(label) || profiler.pool.size < 64 ? label : 'other';
      const row = profiler.pool.get(key) ?? { count: 0, failed: 0, totalMs: 0, maxMs: 0 };
      profiler.pool.set(key, row); const start = profiler.now(); let ok = false;
      const finishPending = profiler.acquisitions.start(key);
      try { const result = await obtain.apply(this, args); ok = true; return result; }
      finally { finishPending(); const ms = profiler.now() - start; row.count++; row.failed += !ok; row.totalMs += ms; row.maxMs = Math.max(row.maxMs, ms); }
    };
    db.createQueryRunner = function (...args) {
      const runner = createRunner.apply(this, args), query = runner.query, connect = runner.connect;
      const occupancy = profiler.occupancy.runner();
      const release = runner.releasePostgresConnection;
      if (typeof release === 'function') runner.releasePostgresConnection = async function (...releaseArgs) {
        const value = await release.apply(this, releaseArgs);
        if (this.isReleased) occupancy.released(Boolean(releaseArgs[0]));
        return value;
      };
      runner.connect = async function (...connectArgs) {
        const scope = profiler.context.getStore(), start = profiler.now();
        try {
          const value = await connect.apply(this, connectArgs);
          occupancy.connected(scope?.label ?? 'unattributed');
          return value;
        }
        finally { if (scope?.query) scope.query.connectMs += profiler.now() - start; }
      };
      runner.query = function (sql, ...queryArgs) {
        const label = profiler.context.getStore()?.label ?? 'unattributed';
        const shape = profiler.shape(sql), key = `${label}:${shape.id}`;
        const finishOccupancy = occupancy.query(shape, label, {
          begin: /^\s*(?:START TRANSACTION|BEGIN)\s*;?\s*$/i.test(sql),
          end: /^\s*COMMIT\s*;?\s*$/i.test(sql) ? 'commit' : /^\s*ROLLBACK\s*;?\s*$/i.test(sql) ? 'rollback' : null,
        });
        let row = profiler.groups.get(key);
        if (!row && profiler.groups.size < profiler.maxGroups) {
          row = { ...shape, context: label, count: 0, failed: 0, totalMs: 0, connectMs: 0, afterConnectMs: 0, maxMs: 0 };
          profiler.groups.set(key, row);
        }
        if (!row) profiler.overflowQueries++;
        const scope = { label, query: { connectMs: 0 } }, start = profiler.now();
        return profiler.context.run(scope, async () => {
          let ok = false;
          try { const result = await query.call(this, sql, ...queryArgs); ok = true; return result; }
          finally {
            finishOccupancy(ok);
            if (row) { const ms = profiler.now() - start; row.count++; row.failed += !ok; row.totalMs += ms;
              row.connectMs += scope.query.connectMs; row.afterConnectMs += Math.max(0, ms - scope.query.connectMs);
              row.maxMs = Math.max(row.maxMs, ms); }
          }
        });
      };
      return runner;
    };
  }
  snapshot() {
    return { queryTimings: 'query-runner wall time; afterConnect includes wire and driver work, not PostgreSQL CPU time',
      poolTimings: 'actual pool acquisition including connection establishment, not query execution',
      connectionOccupancy: this.occupancy.snapshot(),
      pendingAcquisitions: this.acquisitions.snapshot(),
      overflowQueries: this.overflowQueries, queries: [...this.groups.values()].map(r => ({ ...r })),
      activities: Object.fromEntries([...this.activities].map(([k, r]) => [k, { ...r }])),
      pool: Object.fromEntries([...this.pool].map(([k, r]) => [k, { ...r }])) };
  }
}
module.exports = { SqlProfiler };
