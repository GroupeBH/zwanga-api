'use strict';
const os = require('node:os');
const { existsSync, readFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { spawnSync } = require('node:child_process');
const { apiLimits } = require('./api-size.cjs');
const root = resolve(__dirname, '../../..');

function requiredFreeGiB(p) {
  const limits = apiLimits(p);
  // APIs plus a reserve for the generator, disposable PostgreSQL and Redis.
  // This is an admission floor, not a claim that the host reproduces AWS.
  return p.maxTrips > 100 ? Math.max(4, p.replicas * (limits?.memoryMiBPerReplica ?? 1024) / 1024 + 2) : 1.5;
}
function evaluatePreflight(p, facts) {
  const blockers = [], required = requiredFreeGiB(p);
  if (!Number.isFinite(facts.freeGiB) || facts.freeGiB < required) blockers.push('insufficient_free_memory');
  if ((p.maxTrips > 100 || p.containerizedApi) && facts.node !== facts.requiredNode) blockers.push('node_version_mismatch');
  if (!facts.buildPresent) blockers.push('backend_build_missing');
  if (!facts.dependenciesPresent) blockers.push('dependencies_missing');
  if (!facts.postgresBinariesPresent) blockers.push('postgres_binaries_missing');
  if (!facts.redisAvailable) blockers.push('disposable_redis_unavailable');
  if (p.containerizedApi) {
    if (facts.platform !== 'linux') blockers.push('limited_api_requires_linux');
    if (!facts.dockerAvailable) blockers.push('docker_linux_engine_unavailable');
    if (!facts.matchingImage) blockers.push('source_matching_lab_image_missing');
  }
  return { passed: blockers.length === 0, blockers, requiredFreeGiB: required, facts,
    provisionsResources: false, productionCapacityValidated: false, generatorSeparated: false,
    topology: 'single-host-local', limitations: ['PostGIS extension is checked during disposable database bootstrap',
      'No separate generator host; no RDS/ALB/AZ or production capacity validation'] };
}
function inspectLocal(p) {
  const check = (command, args) => {
    const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 64 * 1024 });
    return result.status === 0 ? String(result.stdout).trim() : null;
  };
  const bin = process.env.LOAD_TEST_PG_BIN || (process.platform === 'win32' ? 'C:/Program Files/PostgreSQL/18/bin' : '');
  let dependenciesPresent = true;
  for (const dependency of ['ts-node', 'typeorm', '@nestjs/testing', 'socket.io-client']) {
    try { require.resolve(dependency); } catch { dependenciesPresent = false; }
  }
  const redisAvailable = process.platform === 'win32'
    ? check('wsl.exe', ['-d', 'Ubuntu', '--', 'sh', '-lc', 'command -v redis-server']) !== null
    : check('redis-server', ['--version']) !== null;
  const dockerAvailable = p.containerizedApi && check('docker', ['info', '--format', '{{.OSType}}']) === 'linux';
  let matchingImage = false;
  if (p.containerizedApi && dockerAvailable && process.platform === 'linux') {
    try { require('./lab-image.cjs').inspectImage(); matchingImage = true; } catch { /* fail closed; never build/pull here */ }
  }
  return evaluatePreflight(p, { platform: process.platform, architecture: process.arch,
    node: process.versions.node, requiredNode: readFileSync(join(root, '.nvmrc'), 'utf8').trim(),
    freeGiB: os.freemem() / 2 ** 30, totalGiB: os.totalmem() / 2 ** 30, logicalCpus: os.cpus().length,
    buildPresent: existsSync(join(root, 'dist/app.module.js')), dependenciesPresent,
    postgresBinariesPresent: Boolean(bin) && ['initdb', 'pg_ctl', 'postgres'].every(name =>
      existsSync(join(bin, process.platform === 'win32' ? `${name}.exe` : name))),
    redisAvailable, dockerAvailable: Boolean(dockerAvailable), matchingImage });
}
module.exports = { inspectLocal, evaluatePreflight, requiredFreeGiB };
