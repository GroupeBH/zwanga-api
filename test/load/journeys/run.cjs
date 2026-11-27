'use strict';
// Only this disposable lab process: do not inherit a Windows timezone while
// child APIs or PostgreSQL use UTC. Never load application .env configuration.
process.env.TZ = 'UTC';
const { profile, describe } = require('./profile.cjs');
const args = process.argv.slice(2);
const execute = args.includes('--execute-local');
const preflightOnly = args.includes('--preflight');
const containerizedApi = args.includes('--containerized-api');
const profileSql = args.includes('--profile-sql');
const profileCpu = args.includes('--profile-cpu');
const profileTracking = args.includes('--profile-tracking');
const names = args.filter(a => !a.startsWith('--'));
if (args.some(a => a.startsWith('--') && !['--execute-local', '--preflight', '--containerized-api', '--profile-sql', '--profile-cpu', '--profile-tracking'].includes(a)
    && !a.startsWith('--fixture-seed=') && !a.startsWith('--replica-offset=') && !a.startsWith('--api-size=')) || names.length > 1 || (execute && preflightOnly))
  throw new Error('Usage: node test/load/journeys/run.cjs [profile] [--execute-local | --preflight] [--profile-sql] [--profile-cpu] [--profile-tracking] [--containerized-api] [--api-size=baseline|larger] [--fixture-seed=name] [--replica-offset=0]. No target URL accepted.');
const p = profile(names[0] || 'smoke');
Object.assign(p, require('./scenario-inputs.cjs').scenarioOptions(args, p.replicas));
p.containerizedApi = containerizedApi;
const sizes = args.filter(a => a.startsWith('--api-size='));
if (sizes.length > 1 || (sizes.length && !containerizedApi)) throw new Error('--api-size requires --containerized-api and may appear only once');
p.apiSize = sizes.length ? sizes[0].slice('--api-size='.length) : 'baseline';
require('./api-size.cjs').apiSize(p.apiSize);
p.profileSql = profileSql;
p.profileCpu = profileCpu;
p.profileTracking = profileTracking;
if (preflightOnly) {
  const preflight = require('./local-preflight.cjs').inspectLocal(p);
  console.log(JSON.stringify({ plan: describe(p), preflight }, null, 2));
  if (!preflight.passed) process.exitCode = 1;
}
else if (!execute) { console.log(JSON.stringify(describe(p), null, 2)); }
else {
  const requiredNode = require('node:fs').readFileSync(require('node:path').join(__dirname, '../../../.nvmrc'), 'utf8').trim();
  if ((p.maxTrips > 100 || p.containerizedApi) && process.versions.node !== requiredNode)
    throw new Error(`Higher/limited profiles require Node ${requiredNode}; current ${process.versions.node}`);
  const preflight = require('./local-preflight.cjs').inspectLocal(p);
  if (!preflight.passed) {
    console.error(JSON.stringify({ preflight }, null, 2));
    throw new Error('Local preflight refused; no resources started');
  }
  const { mkdirSync, writeFileSync } = require('node:fs');
  const { resolve, join } = require('node:path');
  const { cpus, totalmem } = require('node:os');
  const { Resources } = require('./resources.cjs');
  const { simulate } = require('./simulation.cjs');
  const output = resolve(__dirname, '../../../tmp/load-results', `journeys-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  mkdirSync(output, { recursive: true });
  const report = { startedAt: new Date().toISOString(), plan: describe(p), stages: [], localScenarioPassed: false,
    productionCapacityValidated: false, platform: process.platform, architecture: process.arch, node: process.version,
    runtimeMatchesDeployment: process.versions.node === requiredNode,
    apiResourceLimits: require('./api-size.cjs').apiLimits(p), preflight,
    sourceHash: require('./lab-image.cjs').sourceHash(),
    host: { logicalCpus: cpus().length, memoryGiB: totalmem() / 2 ** 30 },
    exclusions: ['AWS capacity, ALB/TLS, mobile background GPS', 'Real FCM/APNs, SMS, payments, pricing APIs',
      'Migration chain and financial triggers', 'Ride creation/acceptance/payment lifecycle: active rides are fixtures',
      'Host failure/failover and real production data distribution'],
  };
  const save = () => writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2));
  const resources = new Resources(output), signal = { aborted: false };
  process.once('SIGINT', () => { signal.aborted = true; }); process.once('SIGTERM', () => { signal.aborted = true; });
  (async () => {
    console.log('Creating fresh local PostgreSQL/PostGIS and Redis; no production target.');
    try {
      await resources.start(p); report.schema = resources.fixture.schema;
      report.apiImage = resources.containerImage ?? null;
      report.workerSchedules = resources.workerSchedules;
      report.timeAlignment = resources.timeAlignment;
      if (signal.aborted) throw new Error('Interrupted during bootstrap');
      await simulate(resources, p, report, save, signal);
    } catch (error) {
      report.error = String(error.message).slice(0, 300); process.exitCode = 1;
      console.error('Journey test stopped:', report.error);
    } finally {
      if (p.profileCpu) {
        try { report.cpuProfiles = await resources.cpuProfile('stop'); }
        catch { report.cpuProfileUnavailable = true; }
      }
      report.cleanup = await resources.close();
      if (report.cleanup.errors.length) process.exitCode = 1;
      report.finishedAt = new Date().toISOString(); save();
      console.log(`Private report: ${join(output, 'report.json')}`);
    }
  })().catch(error => { console.error(error.message); process.exitCode = 1; });
}
