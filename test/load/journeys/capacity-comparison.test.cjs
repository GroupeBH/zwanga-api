'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const { join } = require('node:path');
const { profile, describe } = require('./profile.cjs');
const { apiSize, apiLimits } = require('./api-size.cjs');
const { containerArgs } = require('./container-child.cjs');
const { evaluatePreflight, requiredFreeGiB } = require('./local-preflight.cjs');
const { compareReports } = require('./compare-reports.cjs');
const digest = 'sha256:' + 'a'.repeat(64);
const limited = (size = 'baseline') => ({ ...profile('stage-500-mixed'), containerizedApi: true, apiSize: size });
const facts = () => ({ platform: 'linux', node: '24.22.1', requiredNode: '24.22.1', freeGiB: 12,
  buildPresent: true, dependenciesPresent: true, postgresBinariesPresent: true, redisAvailable: true,
  dockerAvailable: true, matchingImage: true });
function report(size = 'baseline') {
  const p = limited(size);
  return { plan: describe(p), localScenarioPassed: true, currentPhase: { phase: 'completed' },
    finishedAt: '2026-11-26T12:00:00Z', cleanup: { errors: [], disposableDatabaseRemoved: true },
    sourceHash: 'b'.repeat(64), apiImage: digest, preflight: { passed: true }, runtimeMatchesDeployment: true,
    node: 'v24.22.1', platform: 'linux', architecture: 'arm64', host: { logicalCpus: 8, memoryGiB: 16 },
    workerSchedules: ['same', 'same'], apiResourceLimits: apiLimits(p),
    outcomes: { pickedUp: 500, droppedOff: 500, requestsWithOffers: 500, waveViolations: 0,
      duplicateDriverOffers: 0, duplicateAcceptances: 0, allocation: { p95Ms: 1200 }, delivery: { p95Ms: 200 } },
    lastHealth: { servers: [{ peakPoolWaiting: 3 }, { peakPoolWaiting: 5 }] } };
}

test('container sizes are explicit, bounded, and preserve sandbox and memory-swap caps', () => {
  for (const size of ['baseline', 'larger']) {
    const limits = apiSize(size), args = containerArgs(digest, 'zwanga-journey-00000000-0000-4000-8000-000000000000', '/tmp/owned.env', size);
    for (const flag of ['--read-only', '--cap-drop', '--security-opt']) assert.ok(args.includes(flag));
    assert.equal(args[args.indexOf('--cpus') + 1], String(limits.cpuPerReplica));
    assert.equal(args[args.indexOf('--memory') + 1], `${limits.memoryMiBPerReplica}m`);
    assert.equal(args[args.indexOf('--memory-swap') + 1], `${limits.memoryMiBPerReplica}m`);
  }
  for (const value of ['', 'prod', 'constructor', '__proto__', '100', null]) assert.throws(() => apiSize(value));
  assert.equal(apiLimits(profile('smoke')), null);
  assert.throws(() => apiLimits({ apiSize: 'larger' }), /containerized/);
  const limits = apiSize(); limits.cpuPerReplica = 99; assert.equal(apiSize().cpuPerReplica, 0.5);
});

test('size comparison changes only container resources, never workload, SQL pools, GPS or guardrails', () => {
  const a = describe(limited()), b = describe(limited('larger'));
  assert.equal(a.databasePoolMaxPerReplica, 10);
  assert.equal(b.safetyLimits.maxWorkerRssMiB, 900);
  assert.equal(b.generatorSeparated, false);
  assert.deepEqual(a.apiResourceLimits, { cpuPerReplica: 0.5, memoryMiBPerReplica: 1024 });
  assert.deepEqual(b.apiResourceLimits, { cpuPerReplica: 1, memoryMiBPerReplica: 2048 });
  delete a.apiResourceLimits; delete b.apiResourceLimits; assert.deepEqual(a, b);
});

test('CLI remains plan-only for both sizes and refuses ambiguous/native/remote execution flags', () => {
  const run = join(__dirname, 'run.cjs');
  for (const size of ['baseline', 'larger']) {
    const plan = JSON.parse(execFileSync(process.execPath,
      [run, 'stage-500-mixed', '--containerized-api', `--api-size=${size}`], { encoding: 'utf8' }));
    assert.deepEqual(plan.apiResourceLimits, apiSize(size)); assert.equal(plan.capacityValidated, false);
  }
  for (const args of [['--api-size=larger'], ['--containerized-api', '--api-size=bad'],
    ['--containerized-api', '--api-size=baseline', '--api-size=larger'], ['--execute-local', '--preflight'],
    ['--containerized-api', '--target=https://compute-api.zwanga-app.com']])
    assert.notEqual(spawnSync(process.execPath, [run, ...args], { encoding: 'utf8' }).status, 0);
});

test('preflight reserves host memory and fails closed without tools, source image or matching runtime', () => {
  assert.equal(requiredFreeGiB(limited()), 4); assert.equal(requiredFreeGiB(limited('larger')), 6);
  const p = { ...limited(), replicas: 3 }; assert.equal(requiredFreeGiB(p), 5);
  assert.equal(evaluatePreflight(p, facts()).passed, true);
  for (const [key, value, blocker] of [['freeGiB', 0.5, 'insufficient_free_memory'],
    ['freeGiB', NaN, 'insufficient_free_memory'], ['node', '22', 'node_version_mismatch'],
    ['platform', 'win32', 'limited_api_requires_linux'], ['buildPresent', false, 'backend_build_missing'],
    ['dependenciesPresent', false, 'dependencies_missing'], ['postgresBinariesPresent', false, 'postgres_binaries_missing'],
    ['redisAvailable', false, 'disposable_redis_unavailable'], ['dockerAvailable', false, 'docker_linux_engine_unavailable'],
    ['matchingImage', false, 'source_matching_lab_image_missing']]) {
    const result = evaluatePreflight(p, { ...facts(), [key]: value });
    assert.equal(result.passed, false); assert.ok(result.blockers.includes(blocker));
    assert.equal(result.provisionsResources, false); assert.equal(result.generatorSeparated, false);
  }
});

test('report comparison allows only like-for-like successful experiments and never authorizes escalation', () => {
  const before = report(), after = report('larger'); after.outcomes.allocation.p95Ms = 900;
  const result = compareReports(before, after);
  assert.equal(result.comparable, true); assert.equal(result.allocationP95DeltaMs, -300);
  assert.equal(result.comparisonType, 'api_size'); assert.equal(result.nextStageAuthorized, false);
  assert.equal(result.productionCapacityValidated, false);
  assert.equal(compareReports(before, before).comparisonType, 'repeatability');
  for (const mutate of [r => { r.localScenarioPassed = false; }, r => { r.error = 'failed'; },
    r => { r.cleanup.errors.push('cleanup'); }, r => { r.cleanup.disposableDatabaseRemoved = false; },
    r => { delete r.sourceHash; }, r => { r.sourceHash = 'c'.repeat(64); },
    r => { r.apiImage = 'sha256:' + 'd'.repeat(64); }, r => { r.plan.replicaOffset = 1; },
    r => { r.plan.safetyLimits.maxInflight = 256; }, r => { r.plan.fixtureSeed = 'other'; },
    r => { r.plan.profileSql = true; }, r => { r.plan.databasePoolMaxPerReplica = 20; },
    r => { r.outcomes.requestsWithOffers = 499; }, r => { r.outcomes.droppedOff = 499; },
    r => { r.outcomes.duplicateAcceptances = 1; }, r => { r.apiResourceLimits = null; },
    r => { r.preflight.passed = false; }, r => { r.runtimeMatchesDeployment = false; },
    r => { r.host.logicalCpus = 2; }, r => { r.workerSchedules = []; }, r => { delete r.host; },
    r => { r.apiResourceLimits = {}; r.plan.apiResourceLimits = {}; }]) {
    const changed = structuredClone(after); mutate(changed);
    const rejected = compareReports(before, changed);
    assert.equal(rejected.comparable, false); assert.equal(rejected.allocationP95DeltaMs, null);
    assert.equal(rejected.comparisonType, 'not-comparable');
  }
  assert.equal(compareReports({}, {}).comparable, false);
  const missing = report(); delete missing.host;
  assert.equal(compareReports(missing, missing).comparable, false);
});

test('two-host and worker preparation never claims provisioning or a remote runner', () => {
  const proposal = JSON.parse(require('node:fs').readFileSync(
    join(__dirname, '../../../infra-aws/profiles/journey-load-lab.proposal.json'), 'utf8'));
  const c = proposal.comparativeValidation;
  assert.equal(proposal.approvedForProvisioning, false); assert.equal(proposal.productionChangesAllowed, false);
  assert.equal(proposal.generator.remoteRunnerImplemented, false);
  assert.equal(c.separateHostValidation.implemented, false);
  assert.equal(c.workerIsolation.status, 'design-only');
  assert.equal(c.cost.approvalRequiredBeforeProvisioning, true);
  for (const size of ['baseline', 'larger']) {
    const limits = apiSize(size);
    assert.equal(c.localApiSizes[size].cpuUnits, limits.cpuPerReplica * 1024);
    assert.equal(c.localApiSizes[size].memoryMiB, limits.memoryMiBPerReplica);
  }
});

test('comparison includes the failure snapshot and never exports arbitrary error text', () => {
  const before = report(); before.localScenarioPassed = false; before.error = 'SECRET_SENTINEL';
  before.failureSnapshot = { sample: { servers: [{ peakPoolWaiting: 67 }, { peakPoolWaiting: 42 }] } };
  const result = compareReports(before, report('larger'));
  assert.deepEqual(result.before.peakPoolWaitingByReplica, [67, 42]);
  assert.ok(!JSON.stringify(result).includes('SECRET_SENTINEL'));
});
