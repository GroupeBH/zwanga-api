'use strict';

// Offline estimate only: no AWS SDK, credentials, .env, Terraform or networking.
const profile = require('../profiles/capacity-175.tfvars.json');
const prices = require('../profiles/prices-eu-central-1-2026-11-10.json');
const round = value => Math.round(value * 100) / 100;
const finite = (name, value, min = 0) => {
  if (!Number.isFinite(value) || value < min) throw new Error(`Invalid ${name}`);
  return value;
};

function estimate(options = {}, selected = profile) {
  const hours = finite('hours', options.hours ?? 744, 1); // full 31-day month
  const lcu = finite('lcu', options.lcu ?? 1);
  const overhead = finite('overhead', options.overhead ?? 25);
  // Sum of extra task-hours: rolling deployments, migrations, optional bursts.
  const extraTaskHours = finite('extraTaskHours', options.extraTaskHours ?? 20);
  if (selected.database_multi_az || selected.ecs_task_cpu_architecture !== 'ARM64') {
    throw new Error('Multi-AZ RDS / x86 must be priced separately; no silent extrapolation');
  }
  const tasks = finite('tasks', selected.ecs_desired_count, 1);
  const redisNodes = finite('redisNodes', selected.redis_num_cache_clusters, 1);
  const cpu = finite('cpu', Number(selected.ecs_task_cpu), 1) / 1024;
  const memory = finite('memory', Number(selected.ecs_task_memory), 1) / 1024;
  const h = prices.hourly;
  const dbRate = finite('RDS rate', h.rds[selected.database_instance_class]);
  const redisRate = finite('Valkey rate', h.valkey[selected.redis_node_type]);
  const taskRate = cpu * h.fargateArmVcpu + memory * h.fargateArmGib;
  const lines = {
    fargate: hours * tasks * taskRate,
    rdsCompute: hours * dbRate,
    rdsStorage: finite('storage', selected.database_allocated_storage_gb, 1) * prices.gibMonth.rdsGp3,
    valkey: hours * redisNodes * redisRate,
    alb: hours * h.alb,
    albCapacity: hours * lcu * h.albLcu,
    // Two ALB addresses, one per ECS task, one existing proxy Elastic IP.
    publicIpv4: hours * (2 + tasks + 1) * h.publicIpv4,
    existingSmsProxy: hours * h.proxyT4gMicro + 8 * prices.gibMonth.ebsGp3,
    temporaryTasks: extraTaskHours * (taskRate + h.publicIpv4),
    otherServicesAllowance: overhead,
  };
  const total = Object.values(lines).reduce((sum, value) => sum + value, 0);
  return {
    region: prices.region, priceDate: prices.checkedAt,
    assumptions: { hours, averageLcu: lcu, extraTaskHours, otherServicesAllowance: overhead,
      taxesIncluded: false, creditsIncluded: false, proxy: 'existing t4g.micro + 8 GiB gp3' },
    linesUsd: Object.fromEntries(Object.entries(lines).map(([key, value]) => [key, round(value)])),
    estimatedUsd: round(total), budgetUsd: selected.monthly_cost_budget_usd,
    headroomUsd: round(selected.monthly_cost_budget_usd - total),
    withinIllustrativeBudget: total <= selected.monthly_cost_budget_usd,
    capacityValidated: false,
    warning: 'Not a quote or a spending cap. Allowance must cover other AWS resources, logs, traces, storage, transfer and CPU credits; tax is extra. No throughput guarantee.',
  };
}

function parseArgs(args) {
  const keys = { '--hours': 'hours', '--lcu': 'lcu', '--overhead': 'overhead', '--extra-task-hours': 'extraTaskHours' };
  const values = {};
  for (const arg of args) {
    const [flag, value, rest] = arg.split('=');
    if (!keys[flag] || value === undefined || value.trim() === '' || rest !== undefined) {
      throw new Error('Usage: node infra-aws/scripts/capacity-cost.cjs [--hours=744] [--lcu=1] [--overhead=25] [--extra-task-hours=20]');
    }
    values[keys[flag]] = Number(value);
  }
  return values;
}

if (require.main === module) {
  try {
    const result = estimate(parseArgs(process.argv.slice(2)));
    console.log(JSON.stringify(result, null, 2));
    if (!result.withinIllustrativeBudget) process.exitCode = 2;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { estimate, parseArgs };
