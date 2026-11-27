'use strict';
const { fork, spawn } = require('node:child_process');
const { mkdtempSync, mkdirSync, createWriteStream, existsSync, rmSync } = require('node:fs');
const { join, resolve, sep } = require('node:path');
const { tmpdir } = require('node:os');
const { randomBytes } = require('node:crypto');
const { createServer } = require('node:net');
const { minimalEnvironment } = require('../isolation.cjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const root = resolve(__dirname, '../../..');
async function freePort() {
  const s = createServer();
  await new Promise((resolve, reject) => { s.once('error', reject); s.listen(0, '127.0.0.1', resolve); });
  const port = s.address().port; await new Promise(resolve => s.close(resolve)); return port;
}
function rpc(child, type, timeoutMs = 15000, payload = {}) {
  const id = randomBytes(8).toString('hex');
  return new Promise((resolve, reject) => {
    const finish = (error, value) => {
      clearTimeout(timer); child.off('message', message); child.off('exit', exit);
      error ? reject(error) : resolve(value);
    };
    const message = value => { if (value.id === id) finish(null, value); };
    const exit = () => finish(new Error('Backend exited during RPC'));
    const timer = setTimeout(() => finish(new Error('Backend metrics deadline')), timeoutMs);
    child.on('message', message); child.once('exit', exit);
    if (!child.connected) finish(new Error('Backend IPC closed'));
    else child.send({ ...payload, type, id }, error => { if (error) finish(new Error('Backend IPC failed')); });
  });
}
class Resources {
  constructor(output) { this.output = output; this.children = []; this.logs = []; }
  async start(p) {
    if (p.containerizedApi) this.containerImage = require('./lab-image.cjs').inspectImage();
    require('ts-node').register({ project: join(root, 'tsconfig.json'), transpileOnly: true });
    require('reflect-metadata');
    const { IsolatedPostgres } = require('../../isolated-postgres.ts');
    const { createClient } = require('redis');
    const bin = process.env.LOAD_TEST_PG_BIN || (process.platform === 'win32' ? 'C:/Program Files/PostgreSQL/18/bin' : '');
    const dist = join(root, 'dist');
    if (!bin || !existsSync(join(dist, 'app.module.js'))) throw new Error('Build first; PostgreSQL/PostGIS binaries required');
    this.scratch = mkdtempSync(join(tmpdir(), 'zwanga-journeys-'));
    const working = join(this.scratch, 'app'); mkdirSync(working);
    this.cluster = new IsolatedPostgres(bin, { ioTiming: p.profileSql }); this.db = await this.cluster.start();
    this.timeAlignment = { generator: await require('./time-alignment.cjs').verifyTimeAlignment(this.db), apis: [] };
    const redisPort = await freePort(), password = randomBytes(24).toString('hex');
    const args = ['--bind', '127.0.0.1', '--port', String(redisPort), '--save', '', '--appendonly', 'no',
      '--protected-mode', 'yes', '--requirepass', password, '--maxmemory', '128mb', '--maxmemory-policy', 'noeviction'];
    this.redisProcess = process.platform === 'win32'
      ? spawn('wsl.exe', ['-d', 'Ubuntu', '--', 'sh', '-lc',
        `exec redis-server --bind 127.0.0.1 --port ${redisPort} --save '' --appendonly no --protected-mode yes --requirepass ${password} --maxmemory 128mb --maxmemory-policy noeviction`],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      : spawn('redis-server', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.redisProcess.on('error', () => { this.redisLaunchFailed = true; });
    this.log(this.redisProcess, 'redis.log');
    this.redis = createClient({ socket: { host: '127.0.0.1', port: redisPort, connectTimeout: 1000,
      reconnectStrategy: false }, password });
    this.redis.on('error', () => {});
    for (let i = 0; i < 20; i++) {
      if (this.redisLaunchFailed) throw new Error('Redis launcher unavailable');
      try { await this.redis.connect(); break; } catch { if (i === 19) throw new Error('Disposable Redis unavailable'); await pause(500); }
    }
    if (await this.redis.dbSize() !== 0) throw new Error('Redis must be fresh and empty');
    this.profile = p;
    if (p.resilience) this.redisProxy = await require('./fault-proxy.cjs').redisFaultProxy(redisPort);
    const env = minimalEnvironment({ ZWANGA_JOURNEY_CHILD: '1', NODE_ENV: 'test', TZ: 'UTC', LOG_LEVEL: 'warn',
      LOAD_TEST_BUILD_DIR: dist, DATABASE_HOST: '127.0.0.1', DATABASE_PORT: String(this.db.options.port),
      LOAD_TEST_FAULTS_ENABLED: p.resilience ? '1' : '0',
      LOAD_TEST_PROFILE_SQL: p.profileSql ? '1' : '0',
      LOAD_TEST_PROFILE_CPU: p.profileCpu ? '1' : '0',
      LOAD_TEST_PROFILE_TRACKING: p.profileTracking ? '1' : '0',
      DATABASE_USER: 'audit_test', DATABASE_NAME: 'postgres', TYPEORM_SYNCHRONIZE: 'false',
      REDIS_HOST: '127.0.0.1', REDIS_PORT: String(this.redisProxy?.port ?? redisPort), REDIS_PASSWORD: password,
      JWT_SECRET: randomBytes(32).toString('hex'), JWT_REFRESH_SECRET: randomBytes(32).toString('hex'),
      DRIVER_DISPATCH_ENABLED: 'true', GOOGLE_CLIENT_ID: 'isolated-test', GOOGLE_CLIENT_SECRET: 'isolated-test',
      GOOGLE_CALLBACK_URL: 'http://127.0.0.1/unused', AWS_EC2_METADATA_DISABLED: 'true',
      AWS_SHARED_CREDENTIALS_FILE: join(this.scratch, 'no-aws-credentials'), AWS_CONFIG_FILE: join(this.scratch, 'no-aws-config'),
      AWS_REGION: 'eu-central-1', AWS_REKOGNITION_ENABLED: 'false', AWS_REKOGNITION_KYC_ENABLED: 'false', KYC_PROVIDER: 'didit',
    });
    this.fixture = await require('./fixtures.cjs').seed(this.db, name => require(join(dist, name)), p, env.JWT_SECRET);
    this.origins = [];
    this.workerSchedules = [];
    this.childEnvironment = env; this.workingDirectory = working;
    for (let i = 0; i < p.replicas; i++) {
      await this.startBackend(i);
    }
  }
  async startBackend(i, port = 0) {
      const working = this.workingDirectory, env = { ...this.childEnvironment, LOAD_TEST_HTTP_PORT: String(port),
        LOAD_TEST_REPLICA_INDEX: String(i) };
      const child = this.containerImage
        ? require('./container-child.cjs').containerChild(this.containerImage, env, this.scratch, this.profile.apiSize)
        : fork(join(__dirname, 'server.cjs'), [], { cwd: working, env, windowsHide: true,
          execArgv: ['--max-old-space-size=768'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      this.children[i] = child; this.log(child, `backend-${i}${port ? '-restarted' : ''}.log`);
      const ready = await new Promise((resolve, reject) => {
        const finish = (e, v) => { clearTimeout(timer); child.off('message', message); child.off('exit', exit); e ? reject(e) : resolve(v); };
        const message = v => { if (v.type === 'ready') finish(null, v); };
        const exit = () => finish(new Error(`Backend ${i} bootstrap failed; inspect private log`));
        const timer = setTimeout(() => finish(new Error('Backend bootstrap deadline')), 120000);
        child.on('message', message); child.once('exit', exit); child.once('error', exit);
      });
      this.origins[i] = `http://127.0.0.1:${ready.port}`;
      this.workerSchedules[i] = ready.workers;
      this.timeAlignment.apis[i] = ready.timeAlignment;
  }
  async restartBackend(index) {
    if (!this.profile?.resilience || !Number.isInteger(index) || !this.children[index]) throw new Error('Fault injection not authorized by profile');
    const child = this.children[index], port = Number(new URL(this.origins[index]).port);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Owned backend termination deadline')), 10000);
      child.once('exit', () => { clearTimeout(timer); resolve(); }); child.kill('SIGKILL');
    });
    await this.startBackend(index, port);
  }
  async interruptRedis(milliseconds) {
    if (!this.profile?.resilience || !this.redisProxy || !Number.isInteger(milliseconds) || milliseconds < 1 || milliseconds > 3000)
      throw new Error('Redis interruption outside local fault budget');
    this.redisProxy.interrupt();
    try { await pause(milliseconds); } finally { this.redisProxy.restore(); }
  }
  async pauseProgress(paused) {
    if (!this.profile?.resilience || typeof paused !== 'boolean') throw new Error('Worker pause outside local fault profile');
    await Promise.all(this.children.map(c => rpc(c, 'pause-progress', 3000, { paused })));
  }
  log(child, name) {
    const stream = createWriteStream(join(this.output, name)); this.logs.push(stream);
    child.stdout.pipe(stream, { end: false }); child.stderr.pipe(stream, { end: false });
  }
  async waitSocket(replica, namespace, socketId, room) {
    const end = Date.now() + 10000;
    while (Date.now() < end) {
      const result = await rpc(this.children[replica], 'socket-observed', 3000, { namespace, socketId, room });
      if (result.ready) return;
      await pause(25);
    }
    throw new Error('Authorized socket/room registration deadline');
  }
  async metrics() {
    const requestedAt = new Date().toISOString();
    // Start the database observation together with IPC, not after waiting for a
    // busy API to reply. Timestamps expose the skew between independent samples.
    const [servers, postgres] = await Promise.all([
      Promise.all(this.children.map(c => rpc(c, 'metrics').then(r => r.metrics))),
      require('./postgres-activity.cjs').postgresActivity(this.db, { detailed: Boolean(this.profile?.profileSql) }),
    ]);
    const [queue] = await this.db.query(`SELECT count(*)::int AS pending,
      coalesce(max(extract(epoch FROM (clock_timestamp()-"availableAt"))),0)::float AS "oldestSeconds" FROM ride_progress_jobs`);
    const info = await this.redis.info('stats');
    const evictions = Number(/evicted_keys:(\d+)/.exec(info)?.[1]);
    if (!Number.isFinite(evictions)) throw new Error('Redis statistics missing');
    const dispatch = await require('./fixtures.cjs').dispatchSnapshot(this.db);
    return { requestedAt, completedAt: new Date().toISOString(), servers, postgres, queue, evictions, dispatch };
  }
  async cpuProfile(action) {
    if (!this.profile?.profileCpu || !['start', 'stop'].includes(action)) throw new Error('CPU profile not enabled');
    return Promise.all(this.children.map(c => rpc(c, 'cpu-profile', 15000, { action }).then(r => {
      if (!r.profile || r.profile.state === 'failed') throw new Error('Local CPU profiler failed');
      return r.profile;
    })));
  }
  async close() {
    const errors = [];
    for (const child of this.children) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      try {
        const warning = await require('./stop-owned-backend.cjs').stopOwnedBackend(child);
        if (warning) errors.push(warning);
      } catch { errors.push('backend cleanup failed'); }
    }
    try {
      await this.redisProxy?.close();
      if (this.redis?.isOpen) { try { await this.redis.sendCommand(['SHUTDOWN', 'NOSAVE']); } catch {} }
      if (this.redis?.isOpen) this.redis.disconnect();
      if (this.redisProcess?.exitCode === null) this.redisProcess.kill();
    } catch { errors.push('redis cleanup failed'); }
    try { await this.cluster?.stop(); } catch { errors.push('postgres cleanup failed'); }
    this.logs.forEach(s => s.end());
    if (this.scratch) {
      const folder = resolve(this.scratch), base = resolve(tmpdir()) + sep;
      if (!folder.startsWith(base + 'zwanga-journeys-')) errors.push('scratch path rejected');
      else try { rmSync(folder, { recursive: true, force: true }); } catch { errors.push('scratch cleanup failed'); }
    }
    return { errors, disposableDatabaseRemoved: !errors.some(e => e.includes('postgres')) };
  }
}
module.exports = { Resources, rpc };
