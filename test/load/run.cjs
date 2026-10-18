'use strict';

// Closed-loop HTTP benchmark. Deliberately has NO target URL/database option.
// Run: npm.cmd run build; node test/load/run.cjs
// Needs PostgreSQL + PostGIS and Redis (Ubuntu WSL on Windows).
const { fork, spawn } = require('node:child_process');
const { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, createWriteStream } = require('node:fs');
const { join, resolve, sep } = require('node:path');
const { tmpdir, cpus, totalmem } = require('node:os');
const { createServer } = require('node:net');
const { performance } = require('node:perf_hooks');
const http = require('node:http');
const { randomBytes } = require('node:crypto');
const { once } = require('node:events');
const { minimalEnvironment } = require('./isolation.cjs');
require('ts-node').register({ transpileOnly: true });
const { IsolatedPostgres } = require('../isolated-postgres.ts');
const { createClient } = require('redis');

const root = resolve(__dirname, '../..');
const buildDirectory = resolve(process.env.LOAD_TEST_BUILD_DIR || join(root, 'dist'));
const bin = process.env.LOAD_TEST_PG_BIN || (process.platform === 'win32' ? 'C:/Program Files/PostgreSQL/18/bin' : '');
if (!bin || !existsSync(join(buildDirectory, 'app.module.js'))) {
  throw new Error('Build first; set LOAD_TEST_PG_BIN to a PostgreSQL bin directory with PostGIS installed.');
}
const seconds = Number(process.env.LOAD_TEST_STAGE_SECONDS || 12);
const diagnosticsOnly = process.env.LOAD_TEST_DIAGNOSTICS_ONLY === '1';
if (!Number.isInteger(seconds) || seconds < 2 || seconds > 30) throw new Error('Stage seconds must be 2..30');
const cluster = new IsolatedPostgres(bin);
const scratch = mkdtempSync(join(tmpdir(), 'zwanga-load-'));
const working = join(scratch, 'app'); mkdirSync(working);
const output = join(root, 'tmp', 'load-results', new Date().toISOString().replace(/[:.]/g, '-'));
mkdirSync(output, { recursive: true });
const report = {
  startedAt: new Date().toISOString(), mode: 'local-isolated-closed-loop',
  machine: { platform: process.platform, node: process.version, cpu: cpus()[0].model,
    logicalCpus: cpus().length, totalMemoryGb: totalmem() / 1073741824 },
  fixture: { users: 1000, drivers: 200, vehicles: 200, trips: 10000,
    completedBookings: diagnosticsOnly ? 0 : 20000, notifications: diagnosticsOnly ? 0 : 50000 },
  configuration: { pgPoolMax: 10, defaultThrottleLimit: 10, defaultThrottleTtlMs: 60000, logLevel: 'warn',
    throttle: 'Real guard + Redis; 1000 accounts and synthetic proxy IPs; no auth/throttle bypass',
    schema: 'Current TypeORM entities, spatial indexes, read-history/rating index migrations. Financial SQL triggers not installed.',
    bootstrap: 'Full AppModule via Nest testing; same HTTP guards/pipes/filter; separate generator process',
  },
  exclusions: ['AWS/ALB/TLS/network latency', 'real production database distribution', 'paid APIs/OTP/KYC/push/payments',
    'financial writes/triggers', 'cron jobs', 'Socket.IO traffic/Redis adapter', 'startup readiness/schema gate',
    'soak endurance, multi-instance HA and failover'],
  stages: [], checks: {}, cleanup: {},
};
let child, redisProcess, redis, port, accounts, sequence = 0, messageId = 0, log;
let interrupted = false;
process.on('SIGINT', () => { interrupted = true; });
process.on('SIGTERM', () => { interrupted = true; });
const agent = new http.Agent({ keepAlive: true, maxSockets: 100, maxFreeSockets: 100 });
const scenarios = [
  { name: 'trips_list', path: '/api/v1/trips', valid: body => Array.isArray(body) && body.length === 30 },
  { name: 'trips_geo', path: '/api/v1/trips?departureCoordinates=15.28,-4.34&departureRadiusKm=20&minSeats=1&limit=20',
    valid: body => Array.isArray(body) && body.length === 20 },
  { name: 'profile', path: '/api/v1/users/me', auth: true, valid: (body, user) => body?.user?.id === user.id },
  { name: 'notifications', path: '/api/v1/notifications?limit=20&offset=0', auth: true,
    valid: body => Array.isArray(body.notifications) && body.notifications.length > 0 },
];
const save = () => writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function freePort() {
  const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
function rpc(type) {
  const id = ++messageId;
  return new Promise((resolve, reject) => {
    const finish = (error, result) => { clearTimeout(timeout); child.off('message', onMessage); child.off('exit', onExit); error ? reject(error) : resolve(result); };
    const onMessage = message => { if (message.id === id) finish(null, message); };
    const onExit = () => finish(new Error('Server stopped unexpectedly'));
    const timeout = setTimeout(() => finish(new Error(`Server ${type} timeout`)), 15000);
    child.on('message', onMessage); child.once('exit', onExit); child.send({ type, id });
  });
}
function request(scenario, options = {}) {
  const n = sequence++;
  // Reserve the last account exclusively for rotation tests.
  const user = accounts[n % (accounts.length - 1)];
  const payload = options.body ? JSON.stringify(options.body) : undefined;
  return new Promise(resolve => {
    const start = performance.now();
    let done = false;
    const finish = value => { if (!done) { done = true; clearTimeout(deadline); resolve({ ...value, ms: performance.now() - start }); } };
    const req = http.request({ host: '127.0.0.1', port, path: scenario.path,
      method: payload ? 'POST' : 'GET', agent,
      headers: { 'x-forwarded-for': options.ip || `10.${(n >>> 16) % 250}.${(n >>> 8) % 256}.${n % 256}`,
        ...(scenario.auth ? { authorization: `Bearer ${options.token || user.accessToken}` } : {}),
        ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
      },
    }, res => {
      const chunks = []; let bytes = 0;
      res.on('data', data => { bytes += data.length; if (bytes <= 2_000_000) chunks.push(data); else req.destroy(new Error('response_too_large')); });
      res.on('end', () => {
        let body; try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch {}
        finish({ status: res.statusCode, bytes, valid: res.statusCode === 200 && (!scenario.valid || scenario.valid(body, user)),
          ...(options.capture ? { body, retryAfter: res.headers['retry-after'] } : {}) });
      });
      res.on('aborted', () => finish({ status: 0, valid: false, error: 'response_aborted' }));
    });
    const deadline = setTimeout(() => req.destroy(new Error('request_deadline_10000ms')), 10000);
    req.on('error', error => finish({ status: 0, valid: false, error: error.message }));
    req.end(payload);
  });
}
function summarize(rows, elapsedMs) {
  const sorted = rows.map(r => r.ms).sort((a, b) => a - b);
  const percentile = n => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * n) - 1)] || 0;
  const statuses = {}; for (const row of rows) statuses[row.status] = (statuses[row.status] || 0) + 1;
  return { requests: rows.length, elapsedSeconds: elapsedMs / 1000, requestsPerSecond: rows.length * 1000 / elapsedMs,
    validResponses: rows.filter(r => r.valid).length, invalidResponses: rows.filter(r => !r.valid).length, statuses,
    p50Ms: percentile(.5), p95Ms: percentile(.95), p99Ms: percentile(.99), maxMs: percentile(1),
    bytes: rows.reduce((sum, r) => sum + (r.bytes || 0), 0) };
}
async function stage(name, concurrency, duration, scenarioIndex) {
  await rpc('reset');
  const start = performance.now(), end = start + duration * 1000, rows = [];
  let job = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (performance.now() < end && !interrupted) {
      const n = job++ % 20;
      const index = scenarioIndex ?? (n < 7 ? 0 : n < 12 ? 1 : n < 17 ? 2 : 3);
      const result = await request(scenarios[index]); rows.push({ ...result, scenario: scenarios[index].name });
      if (rows.length >= 100 && rows.slice(-100).filter(r => r.status === 0 || r.status >= 500).length > 20) {
        interrupted = true;
      }
    }
  }));
  const elapsed = performance.now() - start;
  const result = { name, concurrency, scheduledSeconds: duration, ...summarize(rows, elapsed),
    server: (await rpc('metrics')).metrics,
    endpoints: Object.fromEntries(scenarios.map(s => [s.name, summarize(rows.filter(r => r.scenario === s.name), elapsed)])) };
  report.stages.push(result); save();
  console.log(`${name}: ${result.requests} requests, ${result.requestsPerSecond.toFixed(1)} req/s, p95=${result.p95Ms.toFixed(1)}ms, invalid=${result.invalidResponses}, poolWaiting=${result.server.peakPoolWaiting}`);
  if (result.server.blockedExternalConnections > 0) throw new Error('External connection attempted; inspect server.log');
  if (interrupted) throw new Error('Load stopped: interrupted or error safety threshold exceeded');
}

async function main() {
  console.log('Creating disposable PostgreSQL cluster (loopback only)...');
  const source = await cluster.start();
  const pgPort = source.options.port;
  const redisPort = await freePort();
  const password = randomBytes(24).toString('hex');
  const redisArgs = ['--bind', '127.0.0.1', '--port', String(redisPort), '--save', '', '--appendonly', 'no',
    '--protected-mode', 'yes', '--requirepass', password, '--maxmemory', '128mb', '--maxmemory-policy', 'noeviction'];
  if (process.platform === 'win32') {
    // Fixed command + numeric/random-hex parameters only; no shell input from users.
    redisProcess = spawn('wsl.exe', ['-d', 'Ubuntu', '--', 'sh', '-lc',
      `exec redis-server --bind 127.0.0.1 --port ${redisPort} --save '' --appendonly no --protected-mode yes --requirepass ${password} --maxmemory 128mb --maxmemory-policy noeviction`],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } else redisProcess = spawn('redis-server', redisArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
  redisProcess.on('error', error => console.error('Redis launcher:', error.message));
  const redisLog = createWriteStream(join(output, 'redis.log'));
  redisProcess.stdout.pipe(redisLog); redisProcess.stderr.pipe(redisLog);
  redis = createClient({ socket: { host: '127.0.0.1', port: redisPort, connectTimeout: 1000, reconnectStrategy: false }, password });
  redis.on('error', () => {});
  for (let i = 0; i < 15; i++) {
    try { await redis.connect(); break; } catch { if (i === 14) throw new Error('Isolated Redis unavailable'); await delay(500); }
  }
  if (await redis.ping() !== 'PONG') throw new Error('Redis probe failed');
  report.redis = /redis_version:([^\r]+)/.exec(await redis.info('server'))?.[1];
  console.log('Starting isolated backend; seeding synthetic records...');
  const env = minimalEnvironment({ ZWANGA_ISOLATED_LOAD: '1', NODE_ENV: 'test', LOG_LEVEL: 'warn',
    LOAD_TEST_BUILD_DIR: buildDirectory,
    LOAD_TEST_DIAGNOSTICS_ONLY: diagnosticsOnly ? '1' : '0',
    DATABASE_HOST: '127.0.0.1', DATABASE_PORT: String(pgPort), DATABASE_USER: 'audit_test', DATABASE_NAME: 'postgres',
    TYPEORM_SYNCHRONIZE: 'false', REDIS_HOST: '127.0.0.1', REDIS_PORT: String(redisPort), REDIS_PASSWORD: password,
    JWT_SECRET: randomBytes(32).toString('hex'), JWT_REFRESH_SECRET: randomBytes(32).toString('hex'),
    GOOGLE_CLIENT_ID: 'isolated-test', GOOGLE_CLIENT_SECRET: 'isolated-test', GOOGLE_CALLBACK_URL: 'http://127.0.0.1/unused',
    AWS_EC2_METADATA_DISABLED: 'true', AWS_SHARED_CREDENTIALS_FILE: join(scratch, 'no-aws-credentials'),
    AWS_CONFIG_FILE: join(scratch, 'no-aws-config'), AWS_REGION: 'eu-central-1',
    AWS_REKOGNITION_ENABLED: 'false', AWS_REKOGNITION_KYC_ENABLED: 'false', KYC_PROVIDER: 'didit',
  });
  child = fork(join(__dirname, 'server.cjs'), [], { cwd: working, env, windowsHide: true,
    execArgv: ['--max-old-space-size=1536'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  log = createWriteStream(join(output, 'server.log')); child.stdout.pipe(log); child.stderr.pipe(log);
  child.on('message', message => { if (message.type === 'progress') console.log(message.message); });
  const ready = await new Promise((resolve, reject) => {
    const finish = (error, result) => { clearTimeout(timeout); child.off('exit', onExit); child.off('message', onMessage); error ? reject(error) : resolve(result); };
    const onExit = code => finish(new Error(`Backend exited ${code}; see ${join(output, 'server.log')}`));
    const onMessage = message => { if (message.type === 'ready') finish(null, message); };
    const timeout = setTimeout(() => finish(new Error('Fixture/bootstrap exceeded 300s')), 300000);
    child.once('exit', onExit); child.on('message', onMessage);
  });
  port = ready.port; accounts = ready.accounts;
  report.postgres = ready.postgres; report.postgis = ready.postgis;
  for (const scenario of scenarios) {
    if (diagnosticsOnly && scenario.name !== 'trips_geo') continue;
    const response = await request(scenario, { capture: true });
    report.checks[scenario.name] = { status: response.status, valid: response.valid };
    if (!response.valid) throw new Error(`Smoke ${scenario.name}: status=${response.status}; keys=${Object.keys(response.body || {}).join(',')}`);
  }
  if (diagnosticsOnly) {
    report.diagnostics = (await rpc('diagnostics')).diagnostics;
    report.completedAt = new Date().toISOString(); save();
    console.log('Read-only geographic EXPLAIN ANALYZE complete.');
    return;
  }
  await rpc('reset');
  for (let i = 0; i < 3; i++) {
    if (!(await request(scenarios[0])).valid) throw new Error('Cached list response invalid');
  }
  const cacheMetrics = (await rpc('metrics')).metrics;
  report.checks.tripListCache = { repeatedReads: 3, sqlQueries: cacheMetrics.queryCount };
  if (cacheMetrics.queryCount !== 0) throw new Error('Warm unfiltered list did not use its cache');
  // Fixed IP, no JWT: the real public route has a limit of 30/minute.
  const throttle = [];
  for (let i = 0; i < 35; i++) throttle.push(await request(scenarios[0], { ip: '192.0.2.1', capture: true }));
  report.checks.rateLimit = { statuses: summarize(throttle, 1).statuses, retryAfter: throttle.find(r => r.status === 429)?.retryAfter };
  if (report.checks.rateLimit.statuses[200] !== 30 || report.checks.rateLimit.statuses[429] !== 5) throw new Error('Throttle invariant failed');
  const session = accounts.at(-1);
  const refreshed = await Promise.all(Array.from({ length: 10 }, () => request({ path: '/api/v1/auth/refresh' }, {
    body: { refreshToken: session.refreshToken }, capture: true,
  })));
  const winner = refreshed.find(r => r.status === 200);
  report.checks.concurrentRefresh = { statuses: summarize(refreshed, 1).statuses };
  if (!winner || refreshed.filter(r => r.status === 200).length !== 1 || refreshed.filter(r => r.status === 401).length !== 9) throw new Error('Refresh CAS invariant failed');
  report.checks.concurrentRefresh.oldAccessStatus = (await request(scenarios[2], { token: session.accessToken })).status;
  report.checks.concurrentRefresh.newAccessStatus = (await request(scenarios[2], { token: winner.body.accessToken })).status;
  if (report.checks.concurrentRefresh.oldAccessStatus !== 401 || report.checks.concurrentRefresh.newAccessStatus !== 200) throw new Error('Access rotation invariant failed');
  console.log('Smoke/auth/throttling checks passed. Starting bounded load stages...');
  await stage('warmup', 3, 3);
  for (const concurrency of [1, 10, 30, 60]) await stage(`mixed-${concurrency}`, concurrency, seconds);
  for (let i = 0; i < scenarios.length; i++) await stage(scenarios[i].name, 10, seconds, i);
  await stage('recovery', 3, 5);
  report.diagnostics = (await rpc('diagnostics')).diagnostics;
  report.completedAt = new Date().toISOString();
}

async function cleanup() {
  agent.destroy();
  if (child && child.exitCode === null) {
    const exited = once(child, 'exit'); if (child.connected) child.send({ type: 'stop' });
    const deadline = setTimeout(() => child.kill('SIGKILL'), 12000);
    await exited; clearTimeout(deadline);
  }
  report.cleanup.backendStopped = !child || child.exitCode !== null || child.signalCode !== null;
  if (redis?.isOpen) {
    try { await redis.sendCommand(['SHUTDOWN', 'NOSAVE']); } catch { /* SHUTDOWN closes its own connection. */ }
    if (redis.isOpen) await redis.disconnect();
  }
  if (redisProcess && redisProcess.exitCode === null) {
    const exited = once(redisProcess, 'exit');
    const deadline = setTimeout(() => redisProcess.kill(), 5000);
    await exited; clearTimeout(deadline);
  }
  report.cleanup.redisLauncherStopped = !redisProcess || redisProcess.exitCode !== null || redisProcess.signalCode !== null;
  await cluster.stop(); report.cleanup.postgresStoppedAndRemoved = true;
  const safe = resolve(scratch);
  if (!safe.startsWith(resolve(tmpdir()) + sep + 'zwanga-load-')) throw new Error('Refusing unsafe cleanup');
  rmSync(safe, { recursive: true, force: true }); report.cleanup.scratchRemoved = true;
  report.finishedAt = new Date().toISOString(); save();
  console.log(`Report: ${join(output, 'report.json')}`);
}
main().catch(error => { report.error = error.message; process.exitCode = 1; console.error(error.message); })
  .finally(async () => { try { await cleanup(); } catch (error) { report.cleanup.error = error.message; save(); process.exitCode = 1; console.error(error); } });
