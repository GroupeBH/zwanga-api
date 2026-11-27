'use strict';
const { replicaFromApplicationName, API_APPLICATION_FILTER } = require('./replica-identity.cjs');

// Fresh isolated cluster only. Aggregate states/waits, never SQL, backend PIDs,
// connection addresses or business identifiers. These are instantaneous samples,
// not accumulated PostgreSQL execution time or CPU measurements.
async function postgresActivity(db, { detailed = false } = {}) {
  const requestedAt = new Date().toISOString();
  if (detailed) {
    const io = await postgresIo(db);
    // Sample only existing lock waiters, once per normal health sample. Calling
    // pg_blocking_pids at high frequency would itself contend on the lock manager.
    const rows = await db.query(`SELECT pid, application_name AS "applicationName", state, wait_event_type AS "waitType", wait_event AS "waitEvent", query,
      CASE WHEN wait_event_type='Lock' THEN pg_blocking_pids(pid) ELSE ARRAY[]::int[] END AS blockers,
      CASE WHEN state='active' THEN extract(epoch FROM (clock_timestamp()-query_start))*1000 ELSE 0 END::float AS "activeMs",
      coalesce(extract(epoch FROM (clock_timestamp()-xact_start))*1000,0)::float AS "transactionMs",
      pg_size_bytes(current_setting('track_activity_query_size'))::int AS "queryBytes",
      count(*) OVER()::int AS "totalConnections"
      FROM pg_stat_activity WHERE datname=current_database() AND ${API_APPLICATION_FILTER}
        AND backend_type='client backend' AND pid<>pg_backend_pid() ORDER BY pid LIMIT 64`);
    return { requestedAt, completedAt: new Date().toISOString(), io, ...summarizeActivity(rows,
      require('./profiled-tables.cjs').profiledTables(db)) };
  }
  const groups = await db.query(`SELECT application_name AS "applicationName", state, wait_event_type AS "waitType", wait_event AS "waitEvent",
    count(*)::int AS connections,
    coalesce(max(extract(epoch FROM (clock_timestamp()-query_start))*1000)
      FILTER (WHERE state='active'),0)::float AS "oldestActiveMs",
    coalesce(max(extract(epoch FROM (clock_timestamp()-xact_start))*1000),0)::float AS "oldestTransactionMs"
    FROM pg_stat_activity
    WHERE datname=current_database() AND ${API_APPLICATION_FILTER}
      AND backend_type='client backend' AND pid<>pg_backend_pid()
    GROUP BY application_name, state, wait_event_type, wait_event ORDER BY application_name, state, wait_event_type, wait_event LIMIT 128`);
  return { requestedAt, completedAt: new Date().toISOString(), groups: groups.map(({ applicationName, ...group }) =>
    ({ replica: replicaFromApplicationName(applicationName), ...group })) };
}

/** Cumulative counters on the disposable cluster only. Timing is enabled at
 * bootstrap for profiled runs; fsync/synchronous_commit are never disabled.
 * pg_stat_io includes WAL timing on PG18; older versions may have no WAL rows.
 * These counters include setup/checkpoints and are NOT per-query CPU time. */
async function postgresIo(db) {
  const [row] = await db.query(`SELECT current_setting('server_version_num')::int AS "version",
    current_setting('track_io_timing') AS "ioTiming", current_setting('track_wal_io_timing') AS "walTiming",
    current_setting('fsync') AS "fsync", current_setting('synchronous_commit') AS "synchronousCommit",
    (SELECT json_build_object('records',wal_records,'bytes',wal_bytes,'buffersFull',wal_buffers_full,
      'resetAt',stats_reset) FROM pg_stat_wal) AS wal,
    (SELECT coalesce(json_agg(t), '[]'::json) FROM (SELECT backend_type AS backend, object, context,
      reads, read_time AS "readMs", writes, write_time AS "writeMs", fsyncs, fsync_time AS "fsyncMs",
      stats_reset AS "resetAt" FROM pg_stat_io ORDER BY backend_type, object, context) t) AS io,
    (SELECT json_build_object('commits',xact_commit,'rollbacks',xact_rollback,'deadlocks',deadlocks,
      'tempBytes',temp_bytes,'readMs',blk_read_time,'writeMs',blk_write_time,'resetAt',stats_reset)
      FROM pg_stat_database WHERE datname=current_database()) AS database`);
  return row;
}

function summarizeActivity(rows, tables) {
  const profiler = new (require('./sql-profiler.cjs').SqlProfiler)(tables);
  const groups = new Map(), families = new Map(), waits = new Map();
  const safe = row => ({ ...profiler.shape(row.query ?? ''),
    possiblyTruncated: Buffer.byteLength(row.query ?? '') >= row.queryBytes - 4 });
  const descriptors = new Map(rows.map(row => [row.pid, safe(row)]));
  const byPid = new Map(rows.map(row => [row.pid, row]));
  for (const row of rows) {
    const replica = replicaFromApplicationName(row.applicationName);
    const key = JSON.stringify([replica, row.state, row.waitType, row.waitEvent]);
    const group = groups.get(key) ?? { replica, state: row.state, waitType: row.waitType, waitEvent: row.waitEvent,
      connections: 0, oldestActiveMs: 0, oldestTransactionMs: 0 };
    group.connections++; group.oldestActiveMs = Math.max(group.oldestActiveMs, row.activeMs);
    group.oldestTransactionMs = Math.max(group.oldestTransactionMs, row.transactionMs); groups.set(key, group);
    const query = descriptors.get(row.pid), familyKey = `${key}:${query.id}`;
    const family = families.get(familyKey) ?? { ...group, query, connections: 0, oldestActiveMs: 0, oldestTransactionMs: 0 };
    family.connections++; family.oldestActiveMs = Math.max(family.oldestActiveMs, row.activeMs);
    family.oldestTransactionMs = Math.max(family.oldestTransactionMs, row.transactionMs); families.set(familyKey, family);
    for (const pid of new Set(row.blockers)) {
      const blocker = byPid.get(pid);
      const blockingQuery = descriptors.get(pid) ?? null;
      const blockerReplica = replicaFromApplicationName(blocker?.applicationName);
      const waitKey = JSON.stringify([replica, blockerReplica, query.id, row.waitEvent, blockingQuery?.id, blocker?.state]);
      const wait = waits.get(waitKey) ?? { waitingReplica: replica, blockingReplica: blockerReplica, waitingQuery: query, blockingQuery,
        blockerState: blocker?.state ?? 'outside-sample', waitEvent: row.waitEvent,
        links: 0, oldestWaitingActiveMs: 0, oldestBlockingTransactionMs: 0 };
      wait.links++; wait.oldestWaitingActiveMs = Math.max(wait.oldestWaitingActiveMs, row.activeMs);
      wait.oldestBlockingTransactionMs = Math.max(wait.oldestBlockingTransactionMs, blocker?.transactionMs ?? 0);
      waits.set(waitKey, wait);
    }
  }
  return { groups: [...groups.values()], queryFamilies: [...families.values()], blocking: [...waits.values()],
    truncatedConnections: Math.max(0, (rows[0]?.totalConnections ?? rows.length) - rows.length),
    semantics: 'instantaneous sample; idle query is the last statement, not necessarily the lock acquisition; truncated query fingerprints may not match API profiles' };
}
module.exports = { postgresActivity, summarizeActivity, postgresIo };
