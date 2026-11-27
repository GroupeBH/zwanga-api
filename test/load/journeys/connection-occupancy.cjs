'use strict';
const { performance } = require('node:perf_hooks');

// Opt-in lab instrumentation. No runner/client, SQL, parameters or error retained.
// Busy time is the UNION of query-runner calls while leased, not server CPU time.
class ConnectionOccupancy {
  constructor({ now = () => performance.now(), maxActive = 64, maxGroups = 128 } = {}) {
    this.now = now; this.maxActive = maxActive; this.maxGroups = maxGroups;
    this.active = new Set(); this.groups = new Map(); this.untrackedLeases = 0;
  }
  record(kind, label, elapsedMs, busyMs, queries, outcome) {
    let key = `${kind}:${label}`;
    if (!this.groups.has(key) && this.groups.size >= this.maxGroups) key = `${kind}:other`;
    const row = this.groups.get(key) ?? { kind, context: key.slice(kind.length + 1), count: 0,
      totalMs: 0, queryBusyMs: 0, betweenQueriesMs: 0, maxMs: 0, queries: 0, outcomes: {} };
    row.count++; row.totalMs += elapsedMs; row.queryBusyMs += busyMs;
    row.betweenQueriesMs += Math.max(0, elapsedMs - busyMs); row.maxMs = Math.max(row.maxMs, elapsedMs);
    row.queries += queries; row.outcomes[outcome] = (row.outcomes[outcome] ?? 0) + 1;
    this.groups.set(key, row);
  }
  runner() {
    const owner = this;
    let lease, transaction, inQueries = 0, busySince = null, busyMs = 0, queryCount = 0, lastQuery = null;
    const busyAt = now => busyMs + (busySince === null ? 0 : now - busySince);
    const closeTransaction = (now, outcome) => {
      if (!transaction) return;
      owner.record('transaction', transaction.label, now - transaction.started,
        busyAt(now) - transaction.busyAtStart, queryCount - transaction.queriesAtStart, outcome);
      transaction = null;
    };
    return {
      connected(label) {
        if (lease) return;
        lease = { label, started: owner.now(), view: null };
        if (inQueries) busySince = lease.started;
        lease.view = () => ({ context: lease.label, heldMs: owner.now() - lease.started,
          queryActive: inQueries > 0, queryActiveMs: busySince === null ? 0 : owner.now() - busySince,
          lastQuery, transactionContext: transaction?.label ?? null,
          transactionMs: transaction ? owner.now() - transaction.started : null });
        if (owner.active.size < owner.maxActive) owner.active.add(lease.view);
        else owner.untrackedLeases++;
      },
      query(shape, label, { begin = false, end = null } = {}) {
        inQueries++; lastQuery = shape;
        if (lease && busySince === null) busySince = owner.now();
        const started = owner.now();
        const busyBefore = busyAt(started), countBefore = queryCount;
        return ok => {
          const now = owner.now(); queryCount++; inQueries--;
          if (!inQueries && busySince !== null) { busyMs += now - busySince; busySince = null; }
          if (ok && begin && !transaction && lease) transaction = { label,
            started: Math.max(started, lease.started), busyAtStart: busyBefore, queriesAtStart: countBefore };
          if (ok && end) closeTransaction(now, end);
        };
      },
      released(broken = false) {
        if (!lease) return;
        const now = owner.now(); closeTransaction(now, 'released-open');
        owner.record('lease', lease.label, now - lease.started, busyAt(now), queryCount, broken ? 'broken' : 'released');
        owner.active.delete(lease.view); lease = null;
      },
    };
  }
  snapshot() {
    return { semantics: 'leased wall time and union of query-runner calls; betweenQueries is application/driver time, not PostgreSQL idle time',
      groups: [...this.groups.values()].map(r => ({ ...r, outcomes: { ...r.outcomes } })),
      ...this.activeSnapshot() };
  }
  activeSnapshot() {
    return { active: [...this.active].map(view => view()), untrackedLeases: this.untrackedLeases };
  }
}
module.exports = { ConnectionOccupancy };
