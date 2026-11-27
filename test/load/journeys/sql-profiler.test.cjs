'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { join } = require('node:path');
const { SqlProfiler } = require('./sql-profiler.cjs');

function fakeDatabase(tick, expectedError) {
  const connection = {}, db = {
    driver: { async obtainMasterConnection() { tick(4); return [connection, () => {}]; } },
    createQueryRunner() {
      let connected;
      return {
        async connect() { return connected ??= (await db.driver.obtainMasterConnection())[0]; },
        async query(sql, params, structured) {
          assert.equal(this, runner);
          await this.connect(); tick(6);
          if (expectedError) throw expectedError;
          return { params, structured, value: 'unchanged' };
        },
      };
    },
  };
  let runner;
  return { db, runner: () => runner = db.createQueryRunner() };
}

test('SQL profiling separates pool acquisition and query-runner time without changing results', async () => {
  let time = 0;
  const profiler = new SqlProfiler(['bookings'], { now: () => time });
  const fixture = fakeDatabase(ms => time += ms);
  profiler.install(fixture.db);
  const runner = fixture.runner(), params = ['private-token'];
  const value = await profiler.activity('gps', () => runner.query('SELECT * FROM bookings WHERE id=$1', params, true));
  assert.deepEqual(value, { params, structured: true, value: 'unchanged' });
  await profiler.activity('gps', () => runner.query('SELECT * FROM bookings WHERE id=$1', params, true));
  const s = profiler.snapshot(), q = s.queries[0];
  assert.equal(q.count, 2); assert.equal(q.totalMs, 16); assert.equal(q.connectMs, 4); assert.equal(q.afterConnectMs, 12);
  assert.equal(s.pool.gps.count, 1); assert.equal(s.pool.gps.totalMs, 4);
  assert.equal(s.activities.gps.count, 2); assert.equal(s.activities.gps.active, 0);
  assert.ok(!JSON.stringify(s).includes('private-token'));
});

test('profiling propagates the same failure and counts query and activity errors', async () => {
  const originalError = new Error('private-error-content');
  let time = 0;
  const profiler = new SqlProfiler(['bookings'], { now: () => time });
  const fixture = fakeDatabase(ms => time += ms, originalError);
  profiler.install(fixture.db);
  await assert.rejects(profiler.activity('worker', () => fixture.runner().query('SELECT * FROM bookings')), error => error === originalError);
  const s = profiler.snapshot();
  assert.equal(s.queries[0].failed, 1); assert.equal(s.activities.worker.failed, 1);
  assert.ok(!JSON.stringify(s).includes(originalError.message));
});

test('concurrent activities keep separate attribution and provider receiver/arguments', async () => {
  const profiler = new SqlProfiler([]), seen = [];
  const object = { marker: 42, async run(value) { await new Promise(r => setImmediate(r)); seen.push([this.marker, value, profiler.context.getStore().label]); return value; } };
  profiler.wrapMethod(object, 'run', 'provider');
  await Promise.all([object.run(1), profiler.activity('other', async () => { await new Promise(r => setImmediate(r)); seen.push([0, 2, profiler.context.getStore().label]); })]);
  assert.deepEqual(seen, [[42, 1, 'provider'], [0, 2, 'other']]);
});

test('a failed connection acquisition keeps its original error and is not reported as execution', async () => {
  const error = new Error('private pool failure'); let time = 0;
  const fixture = fakeDatabase(ms => time += ms);
  fixture.db.driver.obtainMasterConnection = async () => { time += 7; throw error; };
  const profiler = new SqlProfiler(['bookings'], { now: () => time }); profiler.install(fixture.db);
  await assert.rejects(profiler.activity('gps', () => fixture.runner().query('SELECT * FROM bookings')), e => e === error);
  const s = profiler.snapshot();
  assert.equal(s.pool.gps.failed, 1); assert.equal(s.pool.gps.totalMs, 7);
  assert.equal(s.queries[0].connectMs, 7); assert.equal(s.queries[0].afterConnectMs, 0);
  assert.equal(s.queries[0].failed, 1); assert.ok(!JSON.stringify(s).includes(error.message));
});

test('query descriptors exclude constants, comments, unlisted tables, and parameter values', () => {
  const profiler = new SqlProfiler(['bookings']);
  const a = profiler.shape("SELECT * FROM bookings WHERE code='secret-a' AND n=123 -- comment-a");
  const b = profiler.shape("SELECT * FROM bookings WHERE code='secret-b' AND n=456 -- comment-b");
  assert.equal(a.id, b.id); assert.deepEqual(a.tables, ['bookings']);
  assert.deepEqual(profiler.shape('SELECT * FROM private_table').tables, []);
  assert.ok(!JSON.stringify([...profiler.shapes]).includes('secret'));
});

test('query family cardinality is bounded and unrecorded queries are counted', async () => {
  let time = 0;
  const profiler = new SqlProfiler(['bookings'], { maxGroups: 1, now: () => time });
  const fixture = fakeDatabase(ms => time += ms); profiler.install(fixture.db);
  const runner = fixture.runner();
  await runner.query('SELECT * FROM bookings'); await runner.query('DELETE FROM bookings');
  assert.equal(profiler.snapshot().queries.length, 1);
  assert.equal(profiler.snapshot().overflowQueries, 1);
});

test('SQL profiling is explicit and remains plan-only without execute-local', () => {
  const run = join(__dirname, 'run.cjs');
  const plan = args => JSON.parse(execFileSync(process.execPath, [run, 'stage-500', ...args], { encoding: 'utf8' }));
  assert.equal(plan([]).profileSql, false);
  assert.equal(plan(['--profile-sql']).profileSql, true);
  assert.equal(plan(['--profile-sql']).targetPolicy, 'fresh-local-resources-only');
});
