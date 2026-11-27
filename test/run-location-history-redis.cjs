'use strict';
// Explicit local runner: own password-protected Redis, random loopback port,
// no .env, SQL, AWS, persistence, SMS or push. Never reuse an existing instance.
const { spawn } = require('node:child_process');
const { createServer } = require('node:net');
const { join } = require('node:path');
const { randomBytes } = require('node:crypto');
const { createClient } = require('redis');
const { minimalEnvironment } = require('./load/isolation.cjs');
const root = join(__dirname, '..');
let server, client, child;
async function main() {
  const port = await new Promise((resolve, reject) => {
    const probe = createServer(); probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => { const port = probe.address().port; probe.close(() => resolve(port)); });
  });
  const password = randomBytes(24).toString('hex');
  server = process.platform === 'win32'
    ? spawn('wsl.exe', ['-d', 'Ubuntu', '--exec', 'redis-server', '-'], { env: minimalEnvironment(), windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] })
    : spawn('redis-server', ['-'], { env: minimalEnvironment(), stdio: ['pipe', 'ignore', 'ignore'] });
  let launchError;
  server.once('error', error => { launchError = error; });
  server.stdin.on('error', error => { launchError = error; });
  server.stdin.end(`bind 127.0.0.1\nport ${port}\nsave ""\nappendonly no\nprotected-mode yes\nrequirepass ${password}\nmaxmemory 32mb\nmaxmemory-policy noeviction\n`);
  client = createClient({ socket: { host: '127.0.0.1', port, connectTimeout: 1000, reconnectStrategy: false }, password });
  client.on('error', () => {});
  for (let attempt = 0; attempt < 30; attempt++) {
    if (launchError) throw launchError;
    if (server.exitCode !== null) throw new Error('Disposable Redis exited before readiness');
    try { await client.connect(); break; }
    catch (error) { if (attempt === 29) throw error; await new Promise(resolve => setTimeout(resolve, 500)); }
  }
  if (await client.dbSize() !== 0) throw new Error('Disposable Redis must be empty');
  child = spawn(process.execPath, [join(root, 'node_modules/jest/bin/jest.js'), '--runInBand', '--runTestsByPath',
    'src/common/services/location-history-store.redis.spec.ts'], {
    cwd: root, windowsHide: true, stdio: 'inherit', env: minimalEnvironment({ NODE_ENV: 'test', TZ: 'UTC',
      HISTORY_TEST_REDIS_PORT: String(port), HISTORY_TEST_REDIS_PASSWORD: password, AWS_EC2_METADATA_DISABLED: 'true' }),
  });
  process.exitCode = await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => { child.kill(); reject(new Error('Redis test deadline')); }, 120000);
    child.once('error', error => { clearTimeout(deadline); reject(error); });
    child.once('exit', code => { clearTimeout(deadline); resolve(code ?? 1); });
  });
}
main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(async () => {
  if (client?.isOpen) {
    await client.sendCommand(['SHUTDOWN', 'NOSAVE']).catch(() => {});
    if (client.isOpen) await client.disconnect();
  }
  server?.kill();
});
