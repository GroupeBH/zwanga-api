'use strict';

// No .env, app server, database, provider credentials or paid SMS. One disposable
// password-protected loopback Redis, no persistence; automatically shut down.
const { spawn } = require('node:child_process');
const { createServer } = require('node:net');
const { join } = require('node:path');
const { createClient } = require('redis');
const { randomBytes } = require('node:crypto');
const { minimalEnvironment } = require('./load/isolation.cjs');
const root = join(__dirname, '..');
let server, client;

async function main() {
  const port = await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const chosen = probe.address().port;
      probe.close(() => resolve(chosen));
    });
  });
  const password = randomBytes(24).toString('hex');
  const args = ['--bind', '127.0.0.1', '--port', String(port), '--save', '', '--appendonly', 'no',
    '--protected-mode', 'yes', '--requirepass', password, '--maxmemory', '32mb', '--maxmemory-policy', 'noeviction'];
  server = process.platform === 'win32'
    ? spawn('wsl.exe', ['-d', 'Ubuntu', '--', 'redis-server', ...args], { env: minimalEnvironment(), windowsHide: true, stdio: 'ignore' })
    : spawn('redis-server', args, { env: minimalEnvironment(), stdio: 'ignore' });
  let launchError;
  server.once('error', error => { launchError = error; });
  client = createClient({ socket: { host: '127.0.0.1', port, connectTimeout: 1000, reconnectStrategy: false }, password });
  client.on('error', () => {});
  for (let attempt = 0; attempt < 20; attempt++) {
    if (launchError) throw launchError;
    try { await client.connect(); break; }
    catch (error) { if (attempt === 19) throw error; await new Promise(resolve => setTimeout(resolve, 250)); }
  }
  if (await client.ping() !== 'PONG') throw new Error('Isolated Redis failed to start.');
  const child = spawn(process.execPath, [join(root, 'node_modules/jest/bin/jest.js'), '--runInBand', '--runTestsByPath',
    'src/otp/mobishastra-otp.redis.spec.ts'], {
    cwd: root, windowsHide: true, stdio: 'inherit', env: minimalEnvironment({
      NODE_ENV: 'test', TZ: 'UTC', AWS_EC2_METADATA_DISABLED: 'true',
      OTP_TEST_REDIS_PORT: String(port), OTP_TEST_REDIS_PASSWORD: password,
    }),
  });
  process.exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject); child.once('exit', code => resolve(code ?? 1));
  });
}

main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(async () => {
  if (client?.isOpen) {
    await client.sendCommand(['SHUTDOWN', 'NOSAVE']).catch(() => {});
    if (client.isOpen) await client.disconnect();
  }
  server?.kill();
});
