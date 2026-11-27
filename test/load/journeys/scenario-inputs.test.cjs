'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const { join } = require('node:path');
const { fixtureIds, scenarioOptions, replicaFor } = require('./scenario-inputs.cjs');
const { replicaApplicationName, replicaFromApplicationName } = require('./replica-identity.cjs');

test('identical seeds reproduce synthetic UUID order without making credentials deterministic', () => {
  const a = fixtureIds('same'), b = fixtureIds('same'), c = fixtureIds('other'), seen = new Set();
  for (let i = 0; i < 10000; i++) {
    const id = a(); assert.equal(id, b()); assert.notEqual(id, c());
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/); seen.add(id);
  }
  assert.equal(seen.size, 10000);
});
test('rotation preserves balanced assignments and cross-replica GPS without changing workload', () => {
  for (const replicaOffset of [0, 1, 2]) {
    const p = { replicas: 3, replicaOffset }, counts = [0, 0, 0];
    for (let i = 0; i < 500; i++) {
      counts[replicaFor(i, p)]++; assert.notEqual(replicaFor(i, p), replicaFor(i + 1, p));
      assert.equal(replicaFor(i, p), (replicaFor(i, { replicas: 3 }) + replicaOffset) % 3);
    }
    assert.equal(Math.max(...counts) - Math.min(...counts), 1);
  }
  for (const file of ['simulation.cjs', 'resilience.cjs'])
    assert.doesNotMatch(require('node:fs').readFileSync(join(__dirname, file), 'utf8'), /% p\.replicas/);
});
test('scenario options fail closed for secrets/URLs, invalid rotations and duplicate overrides', () => {
  for (const args of [['--fixture-seed='], ['--fixture-seed=http://remote'], ['--replica-offset=-1'],
    ['--replica-offset=3'], ['--replica-offset=1.1'], ['--replica-offset='],
    ['--fixture-seed=a', '--fixture-seed=b'], ['--replica-offset=0', '--replica-offset=1']])
    assert.throws(() => scenarioOptions(args, 3));
  assert.deepEqual(scenarioOptions(['--fixture-seed=case-1', '--replica-offset=2'], 3), { fixtureSeed: 'case-1', replicaOffset: 2 });
  const run = join(__dirname, 'run.cjs');
  const plan = JSON.parse(execFileSync(process.execPath, [run, 'stage-500-mixed-3api', '--fixture-seed=case-1', '--replica-offset=2'], { encoding: 'utf8' }));
  assert.equal(plan.fixtureSeed, 'case-1'); assert.equal(plan.replicaOffset, 2);
  assert.equal(plan.targetPolicy, 'fresh-local-resources-only'); assert.equal(plan.capacityValidated, false);
  assert.notEqual(spawnSync(process.execPath, [run, 'smoke', '--replica-offset=2']).status, 0);
});
test('replica names are bounded safe labels, never arbitrary application identifiers', () => {
  for (let i = 0; i < 32; i++) assert.equal(replicaFromApplicationName(replicaApplicationName(i)), i + 1);
  for (const value of [-1, 32, NaN, 1.2, undefined]) assert.throws(() => replicaApplicationName(value));
  assert.equal(replicaFromApplicationName('zwanga-journey-api'), 'legacy');
  for (const value of ['private-hostname', 'zwanga-journey-api-33', 'zwanga-journey-api-01'])
    assert.equal(replicaFromApplicationName(value), 'unknown');
});
