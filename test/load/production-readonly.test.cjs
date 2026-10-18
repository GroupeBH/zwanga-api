'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { unsafeState, metricQueries, summarize, ROUTES, STAGES, INTERVAL_MS, BURSTS, HARD_LIMIT_MS } = require('./production-readonly.cjs');
const now = Date.now();
function state() {
  return { service: { running: 1, desired: 1, pending: 0, taskDefinition: 'task:20',
    deployments: [{ status: 'PRIMARY', rollout: 'COMPLETED' }] },
  targets: [{ state: 'healthy' }], alarms: [], metrics: metricQueries().map(q => ({
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
    const s = state(); s.metrics.find(m => m.Id === id).Timestamps = [];
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
});
test('summary describes zero traffic honestly and retains 429/5xx failures', () => {
  assert.deepEqual(summarize([]), { requests: 0, valid: 0, statuses: {}, p50Ms: null,
    p95Ms: null, maxMs: null, resultCounts: [] });
  const summary = summarize([{ status: 200, valid: true, ms: 50, count: 0 },
    { status: 429, valid: false, ms: 100 }, { status: 503, valid: false, ms: 200 }]);
  assert.equal(summary.valid, 1); assert.deepEqual(summary.statuses, { 200: 1, 429: 1, 503: 1 });
  assert.equal(summary.p95Ms, 200);
});
