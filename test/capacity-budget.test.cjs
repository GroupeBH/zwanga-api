const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { estimate, parseArgs } = require('../infra-aws/scripts/capacity-cost.cjs');
const profile = require('../infra-aws/profiles/capacity-175.tfvars.json');

test('explicit budget profile keeps two API tasks and replicated Redis without unbounded scaling', () => {
  assert.equal(profile.ecs_desired_count, 2);
  assert.equal(profile.ecs_enable_autoscaling, true);
  assert.equal(profile.ecs_max_capacity, 3);
  assert.equal(profile.ecs_min_capacity, 2);
  assert.equal(profile.ecs_enable_availability_zone_rebalancing, true);
  assert.equal(profile.ecs_cpu_target_utilization, 60);
  assert.equal(profile.ecs_memory_target_utilization, 70);
  assert.equal(profile.ecs_request_count_per_target, 1000);
  assert.equal(profile.ecs_scale_in_cooldown_seconds, 600);
  assert.equal(profile.ecs_scale_out_cooldown_seconds, 60);
  assert.equal(profile.ecs_task_cpu_architecture, 'ARM64');
  assert.equal(profile.ecs_task_cpu, '512');
  assert.equal(profile.ecs_task_memory, '1024');
  assert.equal(profile.ecs_deployment_minimum_healthy_percent, 100);
  assert.equal(profile.ecs_deployment_maximum_percent, 200);
  assert.equal(profile.alb_enable_stickiness, true);
  assert.equal(profile.redis_num_cache_clusters, 2);
  assert.equal(profile.database_instance_class, 'db.t4g.small');
  assert.equal(profile.database_deletion_protection, true);
  assert.equal(profile.database_skip_final_snapshot, false);
  assert.equal(profile.database_multi_az, false); // explicitly NOT full HA
  assert.equal(profile.runtime_environment_variables, undefined); // never overwrite the runtime map
});

test('automatically loaded production capacity matches the retained profile', () => {
  const source = readFileSync('infra-aws/production.auto.tfvars', 'utf8');
  const assignments = [...source.matchAll(/^([a-z][a-z0-9_]*)\s*=\s*("[^"\r\n]*"|true|false|\d+(?:\.\d+)?)\s*$/gm)];
  const values = Object.fromEntries(assignments.map(([, name, value]) => [name, JSON.parse(value)]));
  assert.equal(new Set(assignments.map(([, name]) => name)).size, assignments.length);
  for (const [key, value] of Object.entries(profile)) {
    assert.equal(values[key], value, `Production capacity drift: ${key}`);
  }
  assert.doesNotMatch(source, /^\s*(alert_email_addresses|runtime_environment_variables)\s*=/m);
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
  assert.equal(r.scaling.maxRollingTasks, 6);
  assert.equal(r.scaling.fullMonthAtMaxWith20DeploymentHoursUsd, 184.21);
  assert.equal(r.scaling.fullMonthAtMaxWithinBudget, false);
});
test('bounded bursts are priced separately from the two-task baseline', () => {
  const burst = estimate({ extraTaskHours: 20 + 31 * 4 });
  assert.equal(burst.estimatedUsd, 167.03);
  assert.equal(burst.scaling.extraTaskHourlyUsd, 0.027715);
  assert.equal(burst.withinIllustrativeBudget, true);
  assert.throws(() => estimate({}, { ...profile, ecs_max_capacity: 1 }));
  assert.throws(() => estimate({}, { ...profile, ecs_min_capacity: 2.5 }));
});
test('autoscaling owns desired count and uses CPU, memory and ALB with shared cooldowns', () => {
  const hcl = readFileSync('infra-aws/ecs.tf', 'utf8');
  assert.match(hcl, /ignore_changes\s*=\s*\[task_definition, desired_count\]/);
  assert.match(hcl, /availability_zone_rebalancing\s*=\s*var.ecs_enable_availability_zone_rebalancing \? "ENABLED" : null/);
  assert.match(hcl, /length\(distinct\(aws_subnet.public\[\*\].availability_zone\)\) >= 2/);
  assert.match(hcl, /var.ecs_min_capacity <= var.ecs_max_capacity/);
  for (const [policy, metric] of [
    ['cpu', 'ECSServiceAverageCPUUtilization'],
    ['memory', 'ECSServiceAverageMemoryUtilization'],
    ['request_count', 'ALBRequestCountPerTarget'],
  ]) {
    const block = hcl.split(`resource "aws_appautoscaling_policy" "ecs_${policy}" {`)[1]?.split('\nresource ')[0];
    assert.ok(block, policy);
    assert.ok(block.includes(metric));
    assert.match(block, /count\s*=\s*var.ecs_enable_autoscaling \? 1 : 0/);
    assert.match(block, /scale_in_cooldown\s*=\s*var.ecs_scale_in_cooldown_seconds/);
    assert.match(block, /scale_out_cooldown\s*=\s*var.ecs_scale_out_cooldown_seconds/);
    assert.doesNotMatch(block, /disable_scale_in\s*=\s*true/);
  }
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
test('generic budget default remains opt-in; enabled production budget requires recipients and never shuts down services', () => {
  const hcl = readFileSync('infra-aws/budget.tf', 'utf8');
  assert.match(hcl, /default\s*= null/);
  assert.match(hcl, /include_credit\s*= false/);
  assert.match(hcl, /include_refund\s*= false/);
  assert.match(hcl, /include_tax\s*= true/);
  assert.match(hcl, /length\(var.alert_email_addresses\) >= 1/);
  assert.match(hcl, /FORECASTED/);
  assert.doesNotMatch(hcl, /resource "aws_budgets_budget_action"/);
});
