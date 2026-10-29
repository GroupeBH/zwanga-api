'use strict';

// Disposable Redis + the existing isolated PostgreSQL suites. Never reads .env,
// production credentials or the application's Redis. Requires local PG/PostGIS.
const { spawn } = require('node:child_process');
const { createServer } = require('node:net');
const { join } = require('node:path');
const { createClient } = require('redis');
const { randomBytes } = require('node:crypto');
const { minimalEnvironment } = require('./load/isolation.cjs');
const root = join(__dirname, '..');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let server, client;

async function main() {
  const pgBin = process.env.DISPATCH_TEST_POSTGRES_BIN;
  if (!pgBin) throw new Error('Set DISPATCH_TEST_POSTGRES_BIN to local PostgreSQL/PostGIS binaries.');
  const port = await new Promise((resolve, reject) => {
    const probe = createServer(); probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port; probe.close(() => resolve(port));
    });
  });
  const env = minimalEnvironment();
  const password = randomBytes(24).toString('hex');
  const args = ['--bind', '127.0.0.1', '--port', String(port), '--save', '', '--appendonly', 'no',
    '--protected-mode', 'yes', '--requirepass', password, '--maxmemory', '128mb', '--maxmemory-policy', 'noeviction'];
  server = process.platform === 'win32'
    ? spawn('wsl.exe', ['-d', 'Ubuntu', '--', 'redis-server', ...args], { env, windowsHide: true, stdio: 'ignore' })
    : spawn('redis-server', args, { env, stdio: 'ignore' });
  let launchError;
  server.on('error', error => { launchError = error; });
  client = createClient({ socket: { host: '127.0.0.1', port, connectTimeout: 1000, reconnectStrategy: false }, password });
  client.on('error', () => {});
  for (let attempt = 0; attempt < 20; attempt++) {
    if (launchError) throw launchError;
    try { await client.connect(); break; }
    catch (error) { if (attempt === 19) throw error; await delay(250); }
  }
  if (await client.ping() !== 'PONG') throw new Error('Isolated Redis did not start.');
  console.log(`Disposable loopback Redis ready on port ${port}.`);
  const suites = process.argv.slice(2);
  if (!suites.length) suites.push(
    'src/trip-requests/dispatch/sequential-dispatch.postgres.spec.ts',
    'src/trip-requests/dispatch/sequential-candidates.spec.ts',
    'src/trip-requests/dispatch/sequential-deadlines.spec.ts',
    'src/trip-requests/shared-trip-postgres.spec.ts',
    'src/trip-requests/trip-request-alert-routing.spec.ts',
    'src/trip-requests/dispatch/dispatch-resilience.spec.ts',
    'src/notifications/urgent-drain.spec.ts',
    'src/notifications/ride-realtime-delivery.spec.ts',
  );
  const child = spawn(process.execPath, [join(root, 'node_modules/jest/bin/jest.js'), '--runInBand', ...suites], {
    cwd: root, windowsHide: true, stdio: 'inherit', env: minimalEnvironment({
      NODE_ENV: 'test', TZ: 'UTC', AWS_EC2_METADATA_DISABLED: 'true',
      DISPATCH_TEST_POSTGRES_BIN: pgBin, DISPATCH_TEST_REDIS_PORT: String(port),
      DISPATCH_TEST_REDIS_PASSWORD: password,
      ...(process.env.DISPATCH_TEST_LOAD === '1' ? { DISPATCH_TEST_LOAD: '1' } : {}),
      ...(process.env.RIDE_AUDIT_MOBILE_ROOT ? { RIDE_AUDIT_MOBILE_ROOT: process.env.RIDE_AUDIT_MOBILE_ROOT } : {}),
    }),
  });
  process.exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject); child.once('exit', code => resolve(code ?? 1));
  });
}

main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(async () => {
  // Only our disposable instance. Shutdown cannot save or touch application data.
  if (client?.isOpen) {
    await client.sendCommand(['SHUTDOWN', 'NOSAVE']).catch(() => {});
    if (client.isOpen) await client.disconnect();
  }
  server?.kill();
});
