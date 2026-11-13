const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { estimate, parseArgs } = require('../infra-aws/scripts/capacity-cost.cjs');
const profile = require('../infra-aws/profiles/capacity-175.tfvars.json');

test('explicit budget profile keeps two API tasks and replicated Redis without unbounded scaling', () => {
  assert.equal(profile.ecs_desired_count, 2);
  assert.equal(profile.ecs_enable_autoscaling, false);
  assert.equal(profile.ecs_max_capacity, 2);
  assert.equal(profile.redis_num_cache_clusters, 2);
  assert.equal(profile.database_instance_class, 'db.t4g.small');
  assert.equal(profile.database_deletion_protection, true);
  assert.equal(profile.database_skip_final_snapshot, false);
  assert.equal(profile.database_multi_az, false); // explicitly NOT full HA
  assert.equal(profile.runtime_environment_variables, undefined); // never overwrite the runtime map
  assert.ok(!readFileSync('infra-aws/production.auto.tfvars', 'utf8').includes('capacity-175'));
});
test('31-day baseline includes hidden costs and does not claim capacity validation', () => {
  const r = estimate();
  assert.equal(r.assumptions.hours, 744);
  assert.equal(r.linesUsd.publicIpv4, 18.6);
  assert.equal(r.linesUsd.otherServicesAllowance, 25);
  assert.ok(r.linesUsd.existingSmsProxy > 7);
  assert.ok(r.linesUsd.temporaryTasks > 0);
  assert.ok(r.estimatedUsd > 160 && r.estimatedUsd < 175);
  assert.equal(r.capacityValidated, false);
});
test('a sustained third task or a medium database exceeds the illustrated budget', () => {
  assert.equal(estimate({ extraTaskHours: 764 }).withinIllustrativeBudget, false);
  assert.equal(estimate({}, { ...profile, database_instance_class: 'db.t4g.medium' }).withinIllustrativeBudget, false);
});
test('traffic and service overruns are visible, never silently capped at 175', () => {
  assert.equal(estimate({ lcu: 5 }).withinIllustrativeBudget, false);
  assert.equal(estimate({ overhead: 50 }).withinIllustrativeBudget, false);
});
test('unknown architectures, prices and invalid inputs fail closed', () => {
  for (const options of [{ hours: 0 }, { lcu: -1 }, { overhead: NaN }, { extraTaskHours: Infinity }]) {
    assert.throws(() => estimate(options));
  }
  assert.throws(() => estimate({}, { ...profile, database_multi_az: true }));
  assert.throws(() => estimate({}, { ...profile, ecs_task_cpu_architecture: 'X86_64' }));
  assert.throws(() => estimate({}, { ...profile, database_instance_class: 'unknown' }));
  assert.throws(() => parseArgs(['--apply']));
  assert.throws(() => parseArgs(['--hours=']));
  assert.deepEqual(parseArgs(['--hours=730', '--lcu=2']), { hours: 730, lcu: 2 });
});
test('budget is opt-in, excludes credits, requires recipients and has no shutdown action', () => {
  const hcl = readFileSync('infra-aws/budget.tf', 'utf8');
  assert.match(hcl, /default\s*= null/);
  assert.match(hcl, /include_credit\s*= false/);
  assert.match(hcl, /include_refund\s*= false/);
  assert.match(hcl, /include_tax\s*= true/);
  assert.match(hcl, /length\(var.alert_email_addresses\) >= 1/);
  assert.match(hcl, /FORECASTED/);
  assert.doesNotMatch(hcl, /resource "aws_budgets_budget_action"/);
});
