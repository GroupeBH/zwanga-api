'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { unsafeState, metricQueries, summarize, recordFinalMonitoring, ROUTES, STAGES, INTERVAL_MS, BURSTS, HARD_LIMIT_MS } = require('./production-readonly.cjs');
const now = Date.now();
function state() {
  return { service: { running: 1, desired: 1, pending: 0, taskDefinition: 'task:20',
    deployments: [{ status: 'PRIMARY', rollout: 'COMPLETED' }] },
  targets: [{ state: 'healthy' }], alarms: [{ name: 'test', state: 'OK' }], metrics: metricQueries().map(q => ({
    Id: q.Id, StatusCode: 'Complete', Timestamps: [new Date(now - 60000).toISOString()],
    Values: [q.Id === 'rds_free_memory' ? 256 * 1024 ** 2 : q.Id === 'rds_free_storage' ? 10 * 1024 ** 3 : 0],
  })) };
}
test('healthy telemetry permits the small fixed plan, not arbitrary targets or volume', () => {
  assert.equal(unsafeState(state(), 'task:20', now), null);
  assert.deepEqual(STAGES, [1, 2, 4]);
  assert.equal(STAGES.reduce((a, b) => a + b, 0) * BURSTS, 42);
  assert.ok(INTERVAL_MS >= 10500 && HARD_LIMIT_MS < 300000);
  assert.deepEqual(Object.keys(ROUTES), ['health', 'list', 'geo']);
  assert.ok(Object.values(ROUTES).every(path => path === '/health' || path.startsWith('/api/v1/trips')));
});
test('low RDS memory refuses traffic even when all AWS alarms say OK', () => {
  const s = state(); s.alarms = [{ name: 'cpu', state: 'OK' }];
  s.metrics.find(m => m.Id === 'rds_free_memory').Values = [73965568];
  assert.equal(unsafeState(s, 'task:20', now), 'Low RDS free memory');
});
test('monitoring gaps, high CPU and server errors refuse traffic', () => {
  for (const id of ['ecs_cpu', 'redis_memory', 'rds_connections']) {
    const s = state(); Object.assign(s.metrics.find(m => m.Id === id), { Timestamps: [], Values: [] });
    assert.match(unsafeState(s, 'task:20', now), /Missing\/stale/);
  }
  for (const [id, value] of [['ecs_cpu', 71], ['rds_connections', 61], ['alb_target_5xx', 1]]) {
    const s = state(); s.metrics.find(m => m.Id === id).Values = [value];
    assert.match(unsafeState(s, 'task:20', now), /Safety threshold/);
  }
  const s = state(); s.metrics.find(m => m.Id === 'ecs_cpu').Timestamps = [new Date(now - 360000).toISOString()];
  assert.match(unsafeState(s, 'task:20', now), /Missing\/stale/);
});
test('deployment changes, unhealthy targets and alarms stop the test', () => {
  const s = state();
  assert.equal(unsafeState(s, 'task:19', now), 'A new deployment started');
  s.targets[0].state = 'unhealthy';
  assert.equal(unsafeState(s, 'task:20', now), 'ALB target not healthy');
  s.targets[0].state = 'healthy'; s.alarms = [{ state: 'ALARM' }];
  assert.equal(unsafeState(s, 'task:20', now), 'CloudWatch alarm active');
});
test('Redis metrics use the observed cluster/node dimensions and keep alarms distinct', () => {
  const metric = metricQueries().find(q => q.Id === 'redis_memory').MetricStat.Metric;
  assert.deepEqual(metric.Dimensions.map(d => d.Name), ['CacheClusterId', 'CacheNodeId']);
  const second = metricQueries().find(q => q.Id === 'redis_node2_memory').MetricStat.Metric;
  assert.equal(second.Dimensions.find(d => d.Name === 'CacheClusterId').Value, 'zwanga-api-production-redis-002');
});

test('a promoted second Redis node remains guarded by CPU, memory and evictions', () => {
  for (const [id, value] of [['redis_node2_cpu', 61], ['redis_node2_memory', 76], ['redis_node2_evictions', 1]]) {
    const s = state(); s.metrics.find(m => m.Id === id).Values = [value];
    assert.equal(unsafeState(s, 'task:20', now), `Safety threshold: ${id}`);
  }
  const s = state(); s.metrics = s.metrics.filter(m => m.Id !== 'redis_node2_cpu');
  assert.equal(unsafeState(s, 'task:20', now), 'Missing/stale monitoring: redis_node2_cpu');
});

test('partial, malformed and non-finite metrics cannot silently pass the preflight', () => {
  for (const change of [{ Values: [] }, { Values: [NaN] }, { Values: [Infinity] },
    { Values: [-1] }, { StatusCode: 'PartialData' }, { Timestamps: ['invalid'] },
    { Timestamps: [new Date(now + 120000).toISOString()] }]) {
    const s = state(); Object.assign(s.metrics.find(m => m.Id === 'ecs_cpu'), change);
    assert.match(unsafeState(s, 'task:20', now), /Invalid\/incomplete/);
  }
  const s = state(); s.metrics = undefined;
  assert.equal(unsafeState(s, 'task:20', now), 'Missing metric monitoring');
});

test('missing alarms and unknown alarm states refuse traffic', () => {
  for (const alarms of [[], undefined]) {
    const s = state(); s.alarms = alarms;
    assert.equal(unsafeState(s, 'task:20', now), 'Missing alarm monitoring');
  }
  const s = state(); s.alarms[0].state = 'INSUFFICIENT_DATA';
  assert.equal(unsafeState(s, 'task:20', now), 'Incomplete alarm monitoring');
});

test('final monitoring failure or degradation cannot be reported as a completed test', async () => {
  for (const readSnapshot of [
    async () => { throw new Error('AWS unavailable'); },
    async () => { const s = state(); s.alarms[0].state = 'ALARM'; return s; },
    async () => { const s = state(); s.service.taskDefinition = 'task:21'; return s; },
  ]) {
    const report = { result: 'completed', snapshots: [state()] };
    assert.ok(await recordFinalMonitoring(report, readSnapshot));
    assert.equal(report.result, 'stopped_early');
  }
  const report = { result: 'completed', snapshots: [state()] };
  assert.equal(await recordFinalMonitoring(report, async () => state()), null);
  assert.equal(report.result, 'completed');
  assert.equal(report.snapshots.length, 2);
});
test('summary describes zero traffic honestly and retains 429/5xx failures', () => {
  assert.deepEqual(summarize([]), { requests: 0, valid: 0, statuses: {}, p50Ms: null,
    p95Ms: null, maxMs: null, resultCounts: [] });
  const summary = summarize([{ status: 200, valid: true, ms: 50, count: 0 },
    { status: 429, valid: false, ms: 100 }, { status: 503, valid: false, ms: 200 }]);
  assert.equal(summary.valid, 1); assert.deepEqual(summary.statuses, { 200: 1, 429: 1, 503: 1 });
  assert.equal(summary.p95Ms, 200);
});
