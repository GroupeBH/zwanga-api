'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const { join } = require('node:path');
const { profile, describe, loopbackOrigin, pointAt, requestBody } = require('./profile.cjs');
const { Metrics, dueWork } = require('./metrics.cjs');
const { checkHealth, checkLatency, matchesPosition } = require('./simulation.cjs');
const { readFileSync } = require('node:fs');
const { httpClient, gps, socketErrorCategory } = require('./transport.cjs');
const { registeredSocketReady } = require('./readiness.cjs');
const { WORKERS } = require('./workers.cjs');

test('capacity plan counts two tracking clients per journey and remains unvalidated', () => {
  const p = profile('capacity'), d = describe(p);
  assert.deepEqual(p.stages.map(s => s.trips), [100, 250, 500, 750, 1000]);
  assert.equal(d.activeTrips, 1000); assert.equal(d.trackingSockets, 2000);
  assert.equal(d.additionalRequests, 5600); assert.equal(d.gpsUpdatesPerSecond, 400);
  assert.equal(d.durationSeconds, 5150); assert.equal(d.capacityValidated, false);
  assert.equal(d.replicas, 4); assert.equal(d.totalSockets, 6000);
  assert.ok(d.plannedSocketCeilingPerReplica < 1600);
  p.stages[0].trips = 999; assert.equal(profile('capacity').stages[0].trips, 100);
});

test('750 hold preserves GPS, replica and safety limits and renews synthetic demand', () => {
  const short = profile('stage-750-mixed'), soak = profile('stage-750-mixed-soak');
  for (const key of ['maxTrips', 'replicas', 'gpsIntervalMs', 'maxInflight', 'maxPoolWaiting', 'maxWorkerRssMiB',
    'maxQueueAgeSeconds', 'maxSchedulerLagMs', 'requestWindowSeconds', 'availableDrivers', 'behavior'])
    assert.equal(soak[key], short[key], key);
  assert.equal(soak.requests, 3000);
  assert.equal(soak.renewSeconds, 300);
  assert.equal(describe(soak).totalSockets, 4500);
  assert.equal(describe(soak).durationSeconds, 1250);
  assert.equal(describe(soak).capacityValidated, false);
});

test('intermediate comparison changes only available driver stock, never the journey or arrival load', () => {
  const sufficient = profile('intermediate-sufficient'), scarce = profile('intermediate-scarce');
  assert.deepEqual(sufficient.stages, scarce.stages);
  assert.deepEqual(sufficient.stages.map(s => s.trips), [10, 50, 100]);
  assert.equal(sufficient.requests, 160); assert.equal(scarce.requests, 160);
  assert.equal(sufficient.availableDrivers, 400); assert.equal(scarce.availableDrivers, 100);
  assert.equal(sufficient.requestWindowSeconds, scarce.requestWindowSeconds);
  for (const p of [sufficient, scarce]) {
    const d = describe(p);
    assert.equal(d.additionalAlertSockets, p.availableDrivers);
    assert.equal(d.trackingSockets, 200); assert.equal(d.gpsUpdatesPerSecond, 40);
    assert.equal(d.availableDriverPositionsPerSecond, p.availableDrivers / 30);
    assert.deepEqual(d.stageRequests, [10, 50, 100]); assert.equal(d.durationSeconds, 380);
    assert.equal(d.capacityValidated, false); assert.equal(p.maxSchedulerLagMs, 1000);
  }
  assert.equal(profile('smoke').availableDrivers, 2);
});

test('intermediate CLI remains plan-only unless explicitly executing locally', () => {
  for (const name of ['intermediate-sufficient', 'intermediate-scarce']) {
    const d = JSON.parse(execFileSync(process.execPath, [join(__dirname, 'run.cjs'), name], { encoding: 'utf8' }));
    assert.equal(d.profile, name); assert.equal(d.activeTrips, 100);
    assert.equal(d.targetPolicy, 'fresh-local-resources-only');
  }
});

test('250 comparisons preserve demand cadence and safety gates while varying one dispatch input', () => {
  const baseline = profile('stage-250');
  const sufficient = profile('stage-250-sufficient'), mixed = profile('stage-250-mixed');
  for (const p of [sufficient, mixed]) {
    for (const key of ['stages', 'stageRequests', 'requests', 'maxTrips', 'replicas', 'requestWindowSeconds',
      'gpsIntervalMs', 'finishSeconds', 'drainSeconds', 'ackTimeoutMs', 'maxInflight', 'maxSchedulerLagMs',
      'maxWorkerRssMiB', 'maxPoolWaiting', 'maxQueueAgeSeconds', 'targetPolicy', 'capacityValidated'])
      assert.deepEqual(p[key], baseline[key], key);
    const d = describe(p);
    assert.equal(d.gpsUpdatesPerSecond, 100);
    assert.equal(d.requestArrivalsPerSecond, 250 / 60);
    assert.equal(d.additionalRequests, 250);
    assert.equal(d.durationSeconds, 350);
    assert.equal(d.replicas, 2);
    assert.ok(d.plannedSocketCeilingPerReplica <= 1600);
  }
  assert.equal(sufficient.availableDrivers, 1000);
  assert.equal(describe(sufficient).behavior, 'ignore');
  assert.equal(describe(sufficient).totalSockets, 2250);
  assert.equal(describe(sufficient).availableDriverPositionsPerSecond, 1000 / 30);
  assert.equal(mixed.availableDrivers, baseline.availableDrivers);
  assert.equal(mixed.behavior, 'mixed');
  assert.equal(describe(mixed).totalSockets, describe(baseline).totalSockets);
});

test('250 comparison CLI is plan-only without explicit local execution', () => {
  for (const name of ['stage-250-sufficient', 'stage-250-mixed']) {
    const d = JSON.parse(execFileSync(process.execPath, [join(__dirname, 'run.cjs'), name], { encoding: 'utf8' }));
    assert.equal(d.profile, name);
    assert.equal(d.activeTrips, 250);
    assert.equal(d.targetPolicy, 'fresh-local-resources-only');
    assert.equal(d.capacityValidated, false);
  }
});

test('500 mixed changes only driver behavior, never workload or safety gates', () => {
  const baseline = profile('stage-500'), mixed = profile('stage-500-mixed');
  const { name: a, behavior: b, ...original } = baseline;
  const { name: c, behavior: d, ...comparison } = mixed;
  assert.deepEqual(comparison, original);
  assert.equal(d, 'mixed');
  const plan = JSON.parse(execFileSync(process.execPath, [join(__dirname, 'run.cjs'), 'stage-500-mixed'], { encoding: 'utf8' }));
  assert.equal(plan.totalSockets, 3000); assert.equal(plan.gpsUpdatesPerSecond, 200);
  assert.equal(plan.targetPolicy, 'fresh-local-resources-only'); assert.equal(plan.capacityValidated, false);
});
test('explicit 500 three-API comparison changes topology only, never offered load or safety gates', () => {
  const { name: a, replicas: baselineReplicas, ...baseline } = profile('stage-500-mixed');
  const { name: b, replicas, minimumReplicas, ...comparison } = profile('stage-500-mixed-3api');
  assert.deepEqual(comparison, baseline);
  assert.equal(baselineReplicas, 2); assert.equal(replicas, 3); assert.equal(minimumReplicas, 3);
  const plan = JSON.parse(execFileSync(process.execPath,
    [join(__dirname, 'run.cjs'), 'stage-500-mixed-3api'], { encoding: 'utf8' }));
  assert.equal(plan.replicas, 3); assert.equal(plan.totalSockets, 3000);
  assert.equal(plan.capacityValidated, false); assert.equal(plan.targetPolicy, 'fresh-local-resources-only');
});

test('750 mixed preserves safety gates and budgets three API replicas for 4500 sockets', () => {
  const { name: a, behavior: b, ...baseline } = profile('stage-750');
  const { name: c, behavior: d, ...mixed } = profile('stage-750-mixed');
  assert.deepEqual(mixed, baseline);
  assert.equal(d, 'mixed');
  const plan = JSON.parse(execFileSync(process.execPath, [join(__dirname, 'run.cjs'), 'stage-750-mixed'], { encoding: 'utf8' }));
  assert.equal(plan.totalSockets, 4500); assert.equal(plan.replicas, 3);
  assert.equal(plan.gpsUpdatesPerSecond, 300); assert.equal(plan.requestArrivalsPerSecond, 12.5);
  assert.equal(plan.targetPolicy, 'fresh-local-resources-only'); assert.equal(plan.capacityValidated, false);
  const smaller = profile('stage-500-mixed');
  for (const key of ['gpsIntervalMs', 'ackTimeoutMs', 'maxInflight', 'maxSchedulerLagMs',
    'maxWorkerRssMiB', 'maxPoolWaiting', 'maxQueueAgeSeconds', 'finishSeconds', 'drainSeconds'])
    assert.equal(mixed[key], smaller[key]);
});

test('remote targets, credentials and ambiguous local URLs are refused', () => {
  for (const url of ['https://compute-api.zwanga-app.com', 'http://localhost:3000', 'http://127.0.0.1',
    'http://127.0.0.1:3000/path', 'http://user:pass@127.0.0.1:3000', 'http://127.0.0.1:3000/?target=prod',
    'file:///tmp/example', 'http://127.0.0.1:3000/#production']) assert.throws(() => loopbackOrigin(url));
  assert.equal(loopbackOrigin('http://127.0.0.1:34567'), 'http://127.0.0.1:34567');
});
test('default CLI plans without provisioning; arbitrary flags fail closed', () => {
  const file = join(__dirname, 'run.cjs');
  const report = JSON.parse(execFileSync(process.execPath, [file, 'capacity'], { encoding: 'utf8' }));
  assert.equal(report.targetPolicy, 'fresh-local-resources-only');
  for (const args of [['--target', 'production'], ['capacity', '--execute'], ['production'], ['smoke', 'capacity']]) {
    assert.notEqual(spawnSync(process.execPath, [file, ...args], { encoding: 'utf8' }).status, 0);
  }
});
test('GPS trajectory starts at pickup, moves together, and reaches destination only in finish', () => {
  assert.deepEqual(pointAt(0), [15.31, -4.3]);
  assert.ok(pointAt(40)[0] > pointAt(0)[0] + .0008);
  for (let age = 0; age < 5500; age += 5) assert.ok(pointAt(age)[0] < 15.317);
  assert.equal(pointAt(150, 1)[0], 15.318);
});
test('request dates are fresh and price/coordinates avoid external estimation APIs', () => {
  const now = Date.UTC(2026, 10, 22), body = requestBody(now);
  assert.equal(Date.parse(body.departureDateMin) - now, 60000);
  assert.equal(Date.parse(body.departureDateMax) - now, 1800000);
  assert.equal(body.maxPricePerSeat, 2500); assert.equal(body.numberOfSeats, 1);
});
test('scheduler refuses missed rate instead of catching up in bursts', () => {
  assert.equal(dueWork(99, 100, 1000), false);
  assert.equal(dueWork(1100, 100, 1000), true);
  assert.throws(() => dueWork(1101, 100, 1000), /lag/);
});
test('histograms bound memory and report overflow as unknown, not fast', () => {
  const m = new Metrics(); for (let i = 0; i < 10000; i++) m.record('gps', 123);
  assert.equal(m.snapshot().gps.p95UpperBoundMs, 200);
  m.record('slow', 10001, false);
  assert.equal(m.snapshot().slow.p95UpperBoundMs, null); assert.equal(m.snapshot().slow.failed, 1);
  assert.throws(() => m.record('gps', NaN)); assert.throws(() => m.record('gps', -1));
});
test('missing metrics and each safety threshold stop the workload', () => {
  const p = profile('smoke');
  const good = { servers: Array.from({ length: 2 }, () => ({ peakRssMiB: 200, peakPoolWaiting: 0,
    receiptAdmission: { waiting: 0, peakWaiting: 0, oldestWaitingMs: 0, wait: { maxMs: 0 }, rejected: { full: 0, expired: 0 } },
    responseAdmission: { waiting: 0, peakWaiting: 0, oldestWaitingMs: 0, wait: { maxMs: 0 }, rejected: { full: 0, expired: 0 } },
    pool: { waiting: 0 }, blockedExternalConnections: 0, workerErrors: 0, sqlErrors: 0,
    sqlAdmission: { waiting: 0, peakWaiting: 0, oldestWaitingMs: 0, lanes: Object.fromEntries(
      ['progress','delivery','dispatch','maintenance'].map(lane => [lane, { deferred: 0, wait: { maxMs: 0 } }])) },
  })), queue: { pending: 0, oldestSeconds: 0 }, evictions: 0 };
  assert.doesNotThrow(() => checkHealth(good, p));
  for (const [key, value] of [['peakRssMiB', 950], ['peakPoolWaiting', 51], ['workerErrors', 1],
    ['blockedExternalConnections', 1], ['peakRssMiB', NaN]]) {
    const bad = structuredClone(good); bad.servers[0][key] = value; assert.throws(() => checkHealth(bad, p));
  }
  assert.throws(() => checkHealth({ ...good, servers: [] }, p));
  assert.throws(() => checkHealth({ ...good, evictions: 1 }, p));
  assert.throws(() => checkHealth({ ...good, queue: { pending: 1, oldestSeconds: 16 } }, p));
  assert.throws(() => checkHealth({ ...good, queue: { pending: 1 } }, p));
  for (const waiting of [51, 69, undefined, NaN]) {
    const bad = structuredClone(good); bad.servers[0].pool.waiting = waiting;
    assert.throws(() => checkHealth(bad, p)); // historical peak cannot hide current congestion
  }
});
test('admission cannot hide SQL pressure by moving it ahead of the pool', () => {
  const p = profile('smoke');
  const good = { servers: Array.from({ length: 2 }, () => ({ peakRssMiB: 200, peakPoolWaiting: 0,
    receiptAdmission: { waiting: 0, peakWaiting: 0, oldestWaitingMs: 0, wait: { maxMs: 0 }, rejected: { full: 0, expired: 0 } },
    responseAdmission: { waiting: 0, peakWaiting: 0, oldestWaitingMs: 0, wait: { maxMs: 0 }, rejected: { full: 0, expired: 0 } },
    pool: { waiting: 0 }, blockedExternalConnections: 0, workerErrors: 0, sqlErrors: 0,
    sqlAdmission: { waiting: 1, peakWaiting: 3, oldestWaitingMs: 10, lanes: Object.fromEntries(
      ['progress','delivery','dispatch','maintenance'].map(lane => [lane, { deferred: 0, wait: { maxMs: 20 } }])) },
  })), queue: { pending: 0, oldestSeconds: 0 }, evictions: 0 };
  assert.doesNotThrow(() => checkHealth(good, p));
  for (const mutate of [s => { s.sqlAdmission.peakWaiting = 51; }, s => { s.sqlAdmission.oldestWaitingMs = 1001; },
    s => { s.sqlAdmission.lanes.progress.deferred = 1; }, s => { s.sqlAdmission.lanes.progress.wait.maxMs = 1001; },
    s => { s.sqlAdmission.waiting = 30; s.pool.waiting = 30; }, s => { delete s.sqlAdmission; },
    s => { s.sqlAdmission.waiting = NaN; }, s => { delete s.sqlAdmission.lanes.delivery; }]) {
    const bad = structuredClone(good); mutate(bad.servers[0]); assert.throws(() => checkHealth(bad, p), /admission/);
  }
  for (const mutate of [s => { delete s.receiptAdmission; }, s => { s.receiptAdmission.waiting = NaN; },
    s => { s.receiptAdmission.rejected.expired = 1; }, s => { s.receiptAdmission.rejected.full = 1; },
    s => { s.receiptAdmission.wait.maxMs = 1001; }, s => { s.receiptAdmission.peakWaiting = 51; },
    s => { s.receiptAdmission.oldestWaitingMs = 1001; },
    s => { s.receiptAdmission.waiting = 15; s.responseAdmission.waiting = 15; s.sqlAdmission.waiting = 10; s.pool.waiting = 11; },
    s => { delete s.responseAdmission; }, s => { s.responseAdmission.rejected.expired = 1; },
    s => { s.responseAdmission.rejected.full = 1; }, s => { s.responseAdmission.wait.maxMs = 1001; },
    s => { s.responseAdmission.oldestWaitingMs = 1001; }, s => { s.responseAdmission.peakWaiting = 51; },
    s => { s.responseAdmission.waiting = NaN; },
    s => { s.responseAdmission.waiting = 20; s.sqlAdmission.waiting = 20; s.pool.waiting = 11; }]) {
    const bad = structuredClone(good); mutate(bad.servers[0]); assert.throws(() => checkHealth(bad, p), /admission/);
  }
});
test('old or different positions cannot satisfy cross-replica delivery', () => {
  const expected = { coordinates: [15.31, -4.3], recordedAt: '2026-11-22T01:00:00.000Z' };
  assert.ok(matchesPosition({ coordinates: expected.coordinates, updatedAt: expected.recordedAt }, expected));
  assert.ok(!matchesPosition({ coordinates: expected.coordinates, updatedAt: '2026-11-22T00:59:59.000Z' }, expected));
  assert.ok(!matchesPosition({ coordinates: [0, 0], updatedAt: expected.recordedAt }, expected));
});
test('HTTP allowlist rejects unrelated or production requests before opening sockets', async () => {
  const client = httpClient(['http://127.0.0.1:34567']);
  try {
    await assert.rejects(client.request('https://compute-api.zwanga-app.com', '/api/v1/trip-requests', 'x', {}));
    await assert.rejects(client.request('http://127.0.0.1:34567', '/api/v1/payments', 'x', {}));
    await assert.rejects(client.request('http://127.0.0.1:34567', '/api/v1/trip-requests', 'x', {}, 'DELETE'));
  } finally { client.close(); }
});
test('GPS requires a positive business acknowledgement matching the operation', async () => {
  const payload = { tripId: 'a', bookingId: 'b', recordedAt: '2026-11-22T00:00:00.000Z' };
  const socket = ack => ({ timeout: () => ({ emitWithAck: async () => ack }) });
  await assert.doesNotReject(gps(socket({ ...payload, success: true, status: 'accepted' }), 'passenger_location_update', payload, 100));
  for (const ack of [{}, { ...payload, success: false }, { ...payload, success: true, status: 'superseded' },
    { ...payload, success: true, status: 'accepted', bookingId: 'other' }])
    await assert.rejects(gps(socket(ack), 'passenger_location_update', payload, 100));
  await assert.rejects(gps(socket({}), 'pay', payload, 100));
});

test('socket diagnostic categories never copy arbitrary payloads into reports', () => {
  assert.equal(socketErrorCategory({ message: 'Authentification requise.' }), 'authentication_not_registered');
  assert.equal(socketErrorCategory({ message: 'Données WebSocket invalides.' }), 'invalid_websocket_data');
  assert.equal(socketErrorCategory({ message: 'Bearer secret' }), 'unclassified');
  assert.equal(socketErrorCategory(null), 'unclassified');
});

test('terminal ride refusals are classified but never treated as accepted GPS', async () => {
  const messages = [
    ['Le trajet n’est plus en cours, le suivi en temps réel est arrêté', 'trip_not_active'],
    ['Le trajet doit être actif pour partager la position', 'trip_not_active'],
    ['Seules les réservations acceptées ou récupérables peuvent partager leur position', 'booking_not_trackable'],
  ];
  for (const [message, category] of messages) {
    assert.equal(socketErrorCategory({ message }), category);
    assert.equal(socketErrorCategory({ message: `${message} Bearer secret` }), 'unclassified');
    const socket = { timeout: () => ({ emitWithAck: async () => ({ success: false, message }) }) };
    await assert.rejects(gps(socket, 'driver_location_update', { tripId: 'synthetic' }, 100));
  }
});

test('JWT decoding alone is not socket readiness; require completed server registration and room', () => {
  const socket = { data: { userId: 'synthetic' }, rooms: new Set() }, sessions = new Map();
  assert.equal(registeredSocketReady(socket, sessions), false);
  sessions.set(socket, {});
  assert.equal(registeredSocketReady(socket, sessions), true);
  assert.equal(registeredSocketReady(socket, sessions, 'trip:synthetic'), false);
  socket.rooms.add('trip:synthetic');
  assert.equal(registeredSocketReady(socket, sessions, 'trip:synthetic'), true);
  sessions.delete(socket);
  assert.equal(registeredSocketReady(socket, sessions), false);
  assert.equal(registeredSocketReady(undefined, sessions), false);
});

test('isolated runtime includes deadlines and alert recovery at backend cadences', () => {
  const expected = { 'RideProgressWorker.tick': 1000, 'DriverDispatchService.tick': 5000,
    'SequentialDispatchService.deadlines': 1000, 'NotificationService.dispatchRealtimeNotifications': 2000,
    'NotificationService.dispatchUrgentNotifications': 5000, 'NotificationService.dispatchTransactionalNotifications': 10000,
    'NotificationService.recoverRideAcknowledgements': 5000, 'NotificationService.reconcileNearbyRequestRinging': 60000 };
  assert.deepEqual(Object.fromEntries(WORKERS.map(w => [`${w.service}.${w.method}`, w.intervalMs])), expected);
  const root = join(__dirname, '../../..');
  for (const w of WORKERS) {
    const source = readFileSync(join(root, 'src', w.path + '.ts'), 'utf8');
    assert.ok(source.includes(`async ${w.method}(`) || source.includes(`${w.method}(): Promise<void>`));
    assert.ok(Object.isFrozen(w));
  }
});
test('each latency gate requires samples, no errors and a known acceptable percentile', () => {
  const good = Object.fromEntries(['driver_ack', 'passenger_ack', 'driver_peer', 'passenger_peer']
    .map(n => [n, { failed: 0, p95UpperBoundMs: 100 }]));
  assert.doesNotThrow(() => checkLatency(good));
  assert.throws(() => checkLatency({}));
  for (const value of [null, undefined, NaN, 1500]) {
    const bad = structuredClone(good); bad.driver_ack.p95UpperBoundMs = value; assert.throws(() => checkLatency(bad));
  }
});
test('fixture initialization refuses nonempty or nonlocal databases before any schema mutation', async () => {
  const { seed } = require('./fixtures.cjs');
  await assert.rejects(seed({ options: { host: 'production' } }), /newly provisioned/);
  await assert.rejects(seed({ options: { host: '127.0.0.1', username: 'audit_test', database: 'postgres' },
    query: async () => [{ n: 1 }] }), /existing application tables/);
});
test('AWS lab is an unapplied isolated proposal aligned with declared production sizes', () => {
  const root = join(__dirname, '../../..');
  const proposal = JSON.parse(readFileSync(join(root, 'infra-aws/profiles/journey-load-lab.proposal.json')));
  const baseline = readFileSync(join(root, 'infra-aws/production.auto.tfvars'), 'utf8');
  assert.equal(proposal.approvedForProvisioning, false);
  assert.equal(proposal.productionChangesAllowed, false);
  assert.equal(proposal.generator.remoteRunnerImplemented, false);
  assert.equal(proposal.isolation.productionIamAndSecretsAllowed, false);
  assert.equal(proposal.isolation.productionPeeringAllowed, false);
  assert.equal(proposal.gates.explicitExtraCostApprovalRequired, true);
  for (const [key, value] of [['ecs_task_cpu', proposal.api.cpuUnitsPerTask], ['ecs_task_memory', proposal.api.memoryMiBPerTask],
    ['ecs_desired_count', proposal.api.initialTasks], ['ecs_max_capacity', proposal.api.autoscalingMaximumTasks],
    ['database_instance_class', proposal.database.class], ['redis_node_type', proposal.redis.nodeType],
    ['redis_num_cache_clusters', proposal.redis.nodes]]) {
    const actual = new RegExp(`^${key}\\s*=\\s*"?([^"\\s]+)`, 'm').exec(baseline)?.[1];
    assert.equal(actual, String(value), key);
  }
});
