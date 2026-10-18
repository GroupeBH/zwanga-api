'use strict';

// Deliberately separate from the isolated benchmark. Fixed production target,
// GET-only allowlist, no credentials/response bodies saved, no retry or proxy spoofing.
const https = require('node:https');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { mkdirSync, writeFileSync } = require('node:fs');
const { resolve, join } = require('node:path');
const { performance } = require('node:perf_hooks');
const execute = promisify(execFile);
const REGION = 'eu-central-1', ACCOUNT = '046374119247';
const PREFIX = 'zwanga-api-production', CLUSTER = `${PREFIX}-cluster`, SERVICE = `${PREFIX}-api`;
const TG = 'targetgroup/zwanga-api-production-api-tg/47218716421646ca';
const LB = 'app/zwanga-api-production-api-alb/e595966267648f03';
const TG_ARN = `arn:aws:elasticloadbalancing:${REGION}:${ACCOUNT}:${TG}`;
const HOST = 'compute-api.zwanga-app.com';
const ROUTES = Object.freeze({
  health: '/health',
  list: '/api/v1/trips',
  geo: '/api/v1/trips?departureCoordinates=15.28%2C-4.34&departureRadiusKm=20&minSeats=1&limit=20',
});
const STAGES = Object.freeze([1, 2, 4]);
const INTERVAL_MS = 10500, BURSTS = 6, HARD_LIMIT_MS = 290000;
const wait = ms => new Promise(done => setTimeout(done, ms));

async function aws(service, operation, ...args) {
  const allowed = new Set(['sts:get-caller-identity', 'ecs:describe-services',
    'ecs:describe-task-definition', 'elbv2:describe-target-health', 'cloudwatch:get-metric-data',
    'cloudwatch:describe-alarms', 'rds:describe-db-instances', 'elasticache:describe-replication-groups']);
  if (!allowed.has(`${service}:${operation}`)) throw new Error('AWS operation is not read-only/allowlisted');
  try {
    const { stdout } = await execute(process.platform === 'win32' ? 'aws.exe' : 'aws',
      [service, operation, ...args, '--region', REGION, '--output', 'json', '--no-cli-pager',
        '--cli-connect-timeout', '5', '--cli-read-timeout', '10'],
      { windowsHide: true, timeout: 20000, maxBuffer: 3 * 1024 * 1024,
        env: { ...process.env, AWS_MAX_ATTEMPTS: '1', AWS_PAGER: '' } });
    return JSON.parse(stdout);
  } catch { throw new Error(`Read-only monitoring unavailable: ${service}/${operation}`); }
}

function metricQueries() {
  const queries = [];
  function add(id, namespace, name, dimensions, stat, period = 60) {
    queries.push({ Id: id, MetricStat: { Metric: { Namespace: namespace, MetricName: name,
      Dimensions: Object.entries(dimensions).map(([Name, Value]) => ({ Name, Value })) },
    Period: period, Stat: stat }, ReturnData: true });
  }
  const ecs = { ClusterName: CLUSTER, ServiceName: SERVICE };
  const rds = { DBInstanceIdentifier: `${PREFIX}-postgres` };
  const redis = { CacheClusterId: `${PREFIX}-redis-001`, CacheNodeId: '0001' };
  const alb = { LoadBalancer: LB, TargetGroup: TG };
  add('ecs_cpu', 'AWS/ECS', 'CPUUtilization', ecs, 'Maximum');
  add('ecs_memory', 'AWS/ECS', 'MemoryUtilization', ecs, 'Maximum');
  add('rds_cpu', 'AWS/RDS', 'CPUUtilization', rds, 'Maximum');
  add('rds_connections', 'AWS/RDS', 'DatabaseConnections', rds, 'Maximum');
  add('rds_free_memory', 'AWS/RDS', 'FreeableMemory', rds, 'Minimum');
  add('rds_swap', 'AWS/RDS', 'SwapUsage', rds, 'Maximum');
  add('rds_free_storage', 'AWS/RDS', 'FreeStorageSpace', rds, 'Minimum');
  add('rds_cpu_credits', 'AWS/RDS', 'CPUCreditBalance', rds, 'Minimum', 300);
  add('redis_cpu', 'AWS/ElastiCache', 'EngineCPUUtilization', redis, 'Maximum');
  add('redis_memory', 'AWS/ElastiCache', 'DatabaseMemoryUsagePercentage', redis, 'Maximum');
  add('redis_evictions', 'AWS/ElastiCache', 'Evictions', redis, 'Sum');
  add('alb_requests', 'AWS/ApplicationELB', 'RequestCount', alb, 'Sum');
  add('alb_target_5xx', 'AWS/ApplicationELB', 'HTTPCode_Target_5XX_Count', alb, 'Sum');
  add('alb_elb_5xx', 'AWS/ApplicationELB', 'HTTPCode_ELB_5XX_Count', { LoadBalancer: LB }, 'Sum');
  add('alb_latency_p95', 'AWS/ApplicationELB', 'TargetResponseTime', alb, 'p95');
  add('alb_unhealthy', 'AWS/ApplicationELB', 'UnHealthyHostCount', alb, 'Maximum');
  return queries;
}

async function snapshot() {
  const now = new Date();
  const [metrics, service, targets, alarms] = await Promise.all([
    aws('cloudwatch', 'get-metric-data', '--start-time', new Date(now - 15 * 60000).toISOString(),
      '--end-time', now.toISOString(), '--scan-by', 'TimestampDescending',
      '--metric-data-queries', JSON.stringify(metricQueries())),
    aws('ecs', 'describe-services', '--cluster', CLUSTER, '--services', SERVICE,
      '--query', 'services[0].{desired:desiredCount,running:runningCount,pending:pendingCount,taskDefinition:taskDefinition,deployments:deployments[].{status:status,rollout:rolloutState}}'),
    aws('elbv2', 'describe-target-health', '--target-group-arn', TG_ARN,
      '--query', 'TargetHealthDescriptions[].{state:TargetHealth.State,reason:TargetHealth.Reason}'),
    aws('cloudwatch', 'describe-alarms', '--alarm-name-prefix', PREFIX,
      '--query', 'MetricAlarms[].{name:AlarmName,state:StateValue,metric:MetricName}'),
  ]);
  return { at: now.toISOString(), service, targets, alarms, metrics: metrics.MetricDataResults };
}

function unsafeState(s, expectedTask, now = Date.now()) {
  if (!s.service || s.service.running !== s.service.desired || s.service.running < 1 || s.service.pending ||
      s.service.deployments.length !== 1 || s.service.deployments[0].rollout !== 'COMPLETED') return 'ECS is not stable';
  if (expectedTask && s.service.taskDefinition !== expectedTask) return 'A new deployment started';
  if (!s.targets.length || s.targets.some(t => t.state !== 'healthy')) return 'ALB target not healthy';
  if (s.alarms.some(a => a.state === 'ALARM')) return 'CloudWatch alarm active';
  const thresholds = { ecs_cpu: 70, ecs_memory: 85, rds_cpu: 70, rds_connections: 60,
    redis_cpu: 60, redis_memory: 75, alb_unhealthy: 0, alb_target_5xx: 0, alb_elb_5xx: 0, redis_evictions: 0,
    alb_latency_p95: 2 };
  const required = ['ecs_cpu', 'ecs_memory', 'rds_cpu', 'rds_connections', 'rds_free_memory',
    'rds_free_storage', 'redis_cpu', 'redis_memory', 'alb_unhealthy'];
  for (const id of required) {
    const m = s.metrics.find(m => m.Id === id);
    if (!m || m.StatusCode !== 'Complete' || !m.Timestamps.length ||
        now - Date.parse(m.Timestamps[0]) > 5 * 60000) return `Missing/stale monitoring: ${id}`;
  }
  for (const m of s.metrics) {
    const recent = m.Values.filter((_, i) => now - Date.parse(m.Timestamps[i]) <= 5 * 60000);
    if (m.Id in thresholds && recent.some(v => v > thresholds[m.Id])) return `Safety threshold: ${m.Id}`;
    if (m.Id === 'rds_free_memory' && recent.some(v => v < 128 * 1024 * 1024)) return 'Low RDS free memory';
    if (m.Id === 'rds_free_storage' && recent.some(v => v < 5 * 1024 ** 3)) return 'Low RDS free storage';
  }
  return null;
}

function summarize(rows) {
  const times = rows.map(r => r.ms).sort((a, b) => a - b);
  const quantile = p => times.length ? times[Math.ceil(times.length * p) - 1] : null;
  const statuses = {};
  for (const row of rows) statuses[row.status] = (statuses[row.status] || 0) + 1;
  return { requests: rows.length, valid: rows.filter(r => r.valid).length, statuses,
    p50Ms: quantile(.5), p95Ms: quantile(.95), maxMs: times.at(-1) ?? null,
    resultCounts: [...new Set(rows.filter(r => r.count !== undefined).map(r => r.count))] };
}

async function main(mode) {
  if (!['--preflight', '--run-confirmed-readonly'].includes(mode)) {
    throw new Error('Explicit mode required: --preflight (AWS reads only) or --run-confirmed-readonly (authorized production GET test)');
  }
  const output = resolve(__dirname, '../../tmp/production-load-results', new Date().toISOString().replace(/[:.]/g, '-'));
  mkdirSync(output, { recursive: true });
  const report = { startedAt: new Date().toISOString(), target: `https://${HOST}`, region: REGION, mode,
    limits: { maxTrafficMs: HARD_LIMIT_MS, maxBusinessConcurrency: 4, burstsPerStage: BURSTS,
      intervalMs: INTERVAL_MS, plannedBusinessRequests: 42, maxBusinessRequestsPerRollingMinute: 24,
      method: 'GET', routes: ROUTES, noRetries: true, noAuthentication: true, noForwardedHeaders: true },
    exclusions: ['authenticated workflows', 'writes/OTP/KYC/push/payments', 'stress/saturation',
      'autoscaling/failover', 'local code deployment', 'database queries outside existing read endpoints'],
    snapshots: [], probes: [], stages: [], requests: [] };
  const save = () => writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2));
  const agent = new https.Agent({ keepAlive: true, maxSockets: 4 });
  let stopped, monitorTimer, deadlineTimer, monitorPromise;
  const inflight = new Set();
  function stop(reason) {
    if (!stopped) { stopped = reason; console.log(`STOP: ${reason}`); }
    for (const req of inflight) req.destroy(new Error('test_stopped'));
  }
  process.once('SIGINT', () => stop('Operator interrupted'));
  process.once('SIGTERM', () => stop('Operator interrupted'));
  async function request(route) {
    if (!Object.hasOwn(ROUTES, route)) throw new Error('Route not allowlisted');
    const start = performance.now(), at = new Date().toISOString();
    return new Promise(resolve => {
      let settled = false, bytes = 0;
      const chunks = [];
      const finish = data => {
        if (settled) return;
        settled = true; clearTimeout(timeout); inflight.delete(req);
        resolve({ at, route, ms: performance.now() - start, bytes, ...data });
      };
      const req = https.request({ hostname: HOST, port: 443, path: ROUTES[route], method: 'GET',
        agent, headers: { accept: 'application/json', 'user-agent': 'Zwanga-Authorized-ReadOnly-Probe/1.0' } }, res => {
        res.on('data', data => {
          bytes += data.length;
          if (bytes > 2 * 1024 * 1024) req.destroy(new Error('response_size_limit'));
          else chunks.push(data);
        });
        res.on('end', () => {
          let body; try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch {}
          const valid = res.statusCode === 200 && (route === 'health' ? body?.status === 'ok' : Array.isArray(body));
          // Never persist the response body, user IDs, names, locations or headers.
          finish({ status: res.statusCode, valid, ...(Array.isArray(body) ? { count: body.length } : {}) });
        });
        res.on('aborted', () => finish({ status: 0, valid: false, error: 'response_aborted' }));
      });
      inflight.add(req);
      const timeout = setTimeout(() => req.destroy(new Error('request_timeout')), 5000);
      req.on('error', error => finish({ status: 0, valid: false,
        error: ['test_stopped', 'request_timeout', 'response_size_limit'].includes(error.message) ? error.message : 'network_error' }));
      req.end();
    });
  }
  try {
    const identity = await aws('sts', 'get-caller-identity', '--query', '{Account:Account}');
    if (identity.Account !== ACCOUNT) throw new Error('Wrong AWS account; refusing production probe');
    const initial = await snapshot(); report.snapshots.push(initial);
    const [task, rds, redis] = await Promise.all([
      aws('ecs', 'describe-task-definition', '--task-definition', initial.service.taskDefinition,
        '--query', 'taskDefinition.{cpu:cpu,memory:memory,containers:containerDefinitions[].{name:name,image:image}}'),
      aws('rds', 'describe-db-instances', '--db-instance-identifier', `${PREFIX}-postgres`,
        '--query', 'DBInstances[0].{status:DBInstanceStatus,class:DBInstanceClass,version:EngineVersion,multiAZ:MultiAZ}'),
      aws('elasticache', 'describe-replication-groups', '--replication-group-id', `${PREFIX}-redis`,
        '--query', 'ReplicationGroups[0].{status:Status,failover:AutomaticFailover,multiAZ:MultiAZ}'),
    ]);
    report.deployment = { task, rds, redis };
    const unsafe = unsafeState(initial);
    if (unsafe || rds.status !== 'available' || redis.status !== 'available') throw new Error(unsafe || 'Dependency not available');
    save();
    if (mode === '--preflight') { report.result = 'preflight_passed'; return; }
    report.trafficStartedAt = new Date().toISOString();
    deadlineTimer = setTimeout(() => stop('Hard traffic time limit reached'), HARD_LIMIT_MS);
    const smoke = [];
    for (const route of ['health', 'list', 'geo']) {
      if (stopped) break;
      const row = await request(route); smoke.push(row); report.probes.push(row);
      if (!row.valid || row.ms > 2500) stop(`Preflight HTTP failed/slow: ${route} (${row.status})`);
    }
    const latencyLimit = Math.min(4000, Math.max(2000, (summarize(smoke).p95Ms || 0) * 3));
    report.limits.abortRequestLatencyMs = latencyLimit;
    const monitor = async () => {
      try {
        const s = await snapshot(); report.snapshots.push(s);
        const unsafe = unsafeState(s, initial.service.taskDefinition);
        if (unsafe) stop(unsafe);
        save();
      } catch (error) { stop(error.message); }
    };
    monitorTimer = setInterval(() => {
      if (!monitorPromise && !stopped) monitorPromise = monitor().finally(() => { monitorPromise = null; });
    }, 30000);
    let sequence = 0;
    for (const burst of STAGES) {
      if (stopped) break;
      const rows = [], stageStart = performance.now();
      console.log(`Starting ${burst} concurrent GET(s), at most ${burst * 6}/minute (same IP/handler quota)`);
      for (let i = 0; i < BURSTS && !stopped; i++) {
        const started = performance.now();
        await Promise.all(Array.from({ length: burst }, async () => {
          if (stopped) return;
          const row = await request(sequence++ % 2 ? 'geo' : 'list');
          rows.push(row); report.requests.push(row);
          if (!row.valid || row.ms > latencyLimit) stop(`HTTP guard: ${row.route} status=${row.status} latency=${Math.round(row.ms)}ms`);
        }));
        save();
        // Fixed spacing, never catch up by sending a delayed burst of traffic.
        if (!stopped) await wait(Math.max(0, INTERVAL_MS - (performance.now() - started)));
      }
      const stage = { concurrency: burst, elapsedMs: performance.now() - stageStart, ...summarize(rows) };
      report.stages.push(stage); console.log(JSON.stringify(stage));
      if (!stopped) {
        const row = await request('health'); report.probes.push(row);
        if (!row.valid || row.ms > latencyLimit) stop('Health degraded');
      }
    }
    report.trafficFinishedAt = new Date().toISOString();
    report.result = stopped ? 'stopped_early' : 'completed';
  } catch (error) {
    report.result = report.trafficStartedAt ? 'stopped_early' : 'preflight_refused'; stop(error.message);
  } finally {
    clearTimeout(deadlineTimer); clearInterval(monitorTimer);
    if (monitorPromise) await monitorPromise;
    if (stopped && report.result === 'completed') report.result = 'stopped_early';
    if (mode === '--run-confirmed-readonly') {
      try { report.snapshots.push(await snapshot()); } catch (error) { report.finalMonitoringError = error.message; }
    }
    agent.destroy();
    report.stopReason = stopped || null;
    report.summary = { all: summarize(report.requests), list: summarize(report.requests.filter(r => r.route === 'list')),
      geo: summarize(report.requests.filter(r => r.route === 'geo')), health: summarize(report.probes.filter(r => r.route === 'health')) };
    report.finishedAt = new Date().toISOString(); report.cleanup = { httpAgentClosed: true, noRemoteResourcesCreated: true };
    save(); console.log(`Report: ${join(output, 'report.json')}`);
    if (stopped) process.exitCode = 1;
  }
}

module.exports = { metricQueries, unsafeState, summarize, ROUTES, STAGES, INTERVAL_MS, BURSTS, HARD_LIMIT_MS };
if (require.main === module) main(process.argv[2]).catch(error => { console.error(error.message); process.exitCode = 1; });
