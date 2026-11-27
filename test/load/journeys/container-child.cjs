'use strict';
const { spawn, execFile } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
const readline = require('node:readline');
const PREFIX = 'ZWANGA_LOCAL_CONTROL:';

function containerArgs(image, name, envPath, size = 'baseline') {
  const limits = require('./api-size.cjs').apiSize(size);
  if (!/^sha256:[a-f0-9]{64}$/.test(image) || !/^zwanga-journey-[a-f0-9-]{36}$/.test(name)) throw new Error('Unowned lab container');
  return ['run', '--rm', '--init', '-i', '--name', name, '--network', 'host', '--cpus', String(limits.cpuPerReplica),
    '--memory', `${limits.memoryMiBPerReplica}m`, '--memory-swap', `${limits.memoryMiBPerReplica}m`, '--pids-limit', '128', '--read-only',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--tmpfs', '/tmp:rw,nosuid,size=128m',
    '--env-file', envPath, image];
}
function containerChild(image, env, scratch, size = 'baseline') {
  require('./api-size.cjs').apiSize(size); // validate before creating any artifact
  const name = `zwanga-journey-${randomUUID()}`, envPath = join(scratch, `${name}.env`);
  const values = { ...env, LOAD_TEST_STDIO: '1', LOAD_TEST_BUILD_DIR: '/app/dist',
    LOG_DIR: '/tmp/logs', UPLOAD_DEST: '/tmp/uploads',
    AWS_SHARED_CREDENTIALS_FILE: '/tmp/no-credentials', AWS_CONFIG_FILE: '/tmp/no-config' };
  if (Object.values(values).some(v => /[\r\n]/.test(v))) throw new Error('Multiline lab environment rejected');
  writeFileSync(envPath, Object.entries(values).map(([k, v]) => `${k}=${v}`).join('\n'), { mode: 0o600, flag: 'wx' });
  const child = spawn('docker', containerArgs(image, name, envPath, size), { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  child.connected = true;
  readline.createInterface({ input: child.stdout }).on('line', line => {
    if (line.startsWith(PREFIX)) {
      try { child.emit('message', JSON.parse(line.slice(PREFIX.length))); } catch { child.emit('error', new Error('Lab IPC parse failed')); }
    }
  });
  child.once('exit', () => { child.connected = false; });
  child.send = (message, callback) => child.stdin.write(JSON.stringify(message) + '\n', callback);
  // Kill only the fresh UUID-named container owned by this handle, not the Docker daemon.
  child.kill = () => { execFile('docker', ['kill', name], { timeout: 10000 }, () => {}); return true; };
  return child;
}
function installStdioBridge() {
  if (process.env.LOAD_TEST_STDIO !== '1') return;
  process.send = message => { process.stdout.write(PREFIX + JSON.stringify(message) + '\n'); return true; };
  Object.defineProperty(process, 'connected', { value: true });
  readline.createInterface({ input: process.stdin }).on('line', line => {
    try { process.emit('message', JSON.parse(line)); } catch { process.exit(1); }
  }).on('close', () => process.emit('message', { type: 'stop' }));
}
module.exports = { containerArgs, containerChild, installStdioBridge };
