'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { TrackingDiagnostics } = require('./tracking-diagnostics.cjs');
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

test('tracking diagnostics are opt-in; target and safety ceilings remain unchanged', () => {
  const { execFileSync } = require('node:child_process');
  const { join } = require('node:path');
  const plan = flags => JSON.parse(execFileSync(process.execPath,
    [join(__dirname, 'run.cjs'), 'stage-500-mixed', ...flags], { encoding: 'utf8' }));
  const plain = plan([]), enabled = plan(['--profile-tracking']);
  assert.equal(plain.profileTracking, false);
  assert.deepEqual(enabled, { ...plain, profileTracking: true });
});
test('wrapping preserves receiver, args, synchronous returns/errors and Promise identity/rejection', async () => {
  const diagnostic = new TrackingDiagnostics(); const pending = deferred(); const error = new Error('private');
  const service = { value: {}, sync(arg) { assert.equal(arg, this.value); return arg; },
    async() { return pending.promise; }, fail() { throw error; } };
  for (const method of ['sync', 'async', 'fail']) diagnostic.wrap(service, method, 'driver_service');
  assert.equal(service.sync(service.value), service.value);
  assert.throws(() => service.fail(), e => e === error);
  assert.equal(service.async(), pending.promise);
  pending.reject(error); await assert.rejects(pending.promise, e => e === error);
  const row = diagnostic.snapshot().phases.driver_service;
  assert.equal(row.active, 0); assert.equal(row.cumulative.count, 3); assert.equal(row.cumulative.failed, 2);
  assert.ok(!JSON.stringify(row).includes('private'));
});
test('snapshots expose overlapping current phases, oldest active age, interval and cumulative peaks', async () => {
  let clock = 0; const diagnostic = new TrackingDiagnostics({ now: () => clock });
  const first = deferred(), second = deferred();
  diagnostic.measure('driver_read', () => first.promise);
  clock = 10; diagnostic.measure('driver_read', () => second.promise);
  clock = 20; let sample = diagnostic.snapshot();
  assert.equal(sample.intervalMs, 20); assert.equal(sample.phases.driver_read.oldestActiveMs, 20);
  assert.equal(sample.phases.driver_read.active, 2);
  first.resolve(); await first.promise;
  clock = 30; sample = diagnostic.snapshot();
  assert.equal(sample.phases.driver_read.oldestActiveMs, 20);
  assert.equal(sample.phases.driver_read.interval.count, 1);
  assert.equal(sample.phases.driver_read.intervalPeakActive, 2);
  second.resolve(); await second.promise;
  const row = diagnostic.snapshot().phases.driver_read;
  assert.equal(row.cumulative.count, 2); assert.equal(row.interval.count, 1);
  assert.equal(row.active, 0); assert.equal(row.oldestActiveMs, 0);
  assert.equal(row.peakActive, 2); assert.equal(row.intervalPeakActive, 1);
});
test('labels and active samples are bounded; incomplete oldest-age measurement is explicit', async () => {
  const diagnostic = new TrackingDiagnostics({ maxActiveSamples: 2 }); const pending = deferred();
  for (let i = 0; i < 3; i++) diagnostic.measure('ws_admission', () => pending.promise);
  assert.throws(() => diagnostic.measure('private-key', () => 1), /Unknown/);
  const row = diagnostic.snapshot().phases.ws_admission;
  assert.equal(row.active, 3); assert.equal(row.untrackedActiveSamples, 1); assert.equal(row.oldestActiveMs, null);
  assert.equal(diagnostic.rows.get('ws_admission').starts.size, 2);
  pending.resolve(); await pending.promise;
  assert.equal(diagnostic.snapshot().phases.ws_admission.active, 0);
});
test('SQL helper and acquisition spans remain scoped across concurrent async reads/writes', async () => {
  const diagnostic = new TrackingDiagnostics(); const pending = deferred(); let calls = 0;
  const db = { driver: { obtainMasterConnection() { assert.equal(this, db.driver); calls++; return pending.promise; } } };
  const helpers = {};
  for (const name of ['claimRideProgress', 'finishRideProgress', 'finishAndClaimRideProgress', 'retireRequestInvitations']) helpers[name] = async () => undefined;
  for (const name of ['readDriverTrackingTrip', 'readPassengerTrackingBooking', 'persistDriverLocation', 'persistPassengerLocation', 'readRideProgressBookings'])
    helpers[name] = async function () { await Promise.resolve(); return db.driver.obtainMasterConnection(); };
  diagnostic.installSql(db, () => helpers);
  const read = helpers.readDriverTrackingTrip(), write = helpers.persistPassengerLocation(), progress = helpers.readRideProgressBookings();
  await helpers.retireRequestInvitations();
  await Promise.resolve();
  const phases = diagnostic.snapshot().phases;
  for (const label of ['driver_read', 'driver_read_pool', 'passenger_write', 'passenger_write_pool', 'progress_read', 'progress_read_pool']) assert.equal(phases[label].active, 1);
  assert.equal(phases.dispatch_retire.cumulative.count, 1);
  assert.equal(phases.driver_write_pool.active, 0);
  pending.resolve({}); await Promise.all([read, write, progress]);
  assert.equal(calls, 3); assert.equal(diagnostic.snapshot().phases.passenger_write.active, 0);
});
test('broadcast measures synchronous scheduling separately from Redis publication and preserves packets', async () => {
  let clock = 0; const diagnostic = new TrackingDiagnostics({ now: () => clock });
  const pending = deferred(); const packet = { data: ['driver_location', { secret: 'never retained' }] };
  const pub = { publish(channel, payload) { assert.equal(this, pub); assert.equal(channel, 'private'); assert.equal(payload, packet); return pending.promise; } };
  const adapter = { broadcast(p, options) { assert.equal(this, adapter); assert.equal(options, 7); pub.publish('private', p); clock += 1; } };
  diagnostic.installPublisher(pub); diagnostic.installBroadcast(adapter);
  assert.equal(adapter.broadcast(packet, 7), undefined);
  let phases = diagnostic.snapshot().phases;
  assert.equal(phases.broadcast_driver.active, 0); assert.equal(phases.broadcast_driver.cumulative.maxMs, 1);
  assert.equal(phases.publish_driver.active, 1); assert.equal(phases.publish_other.active, 0);
  clock = 10; pending.resolve(1); await pending.promise;
  phases = diagnostic.snapshot().phases;
  assert.equal(phases.publish_driver.cumulative.maxMs, 10);
  assert.ok(!JSON.stringify(phases).includes('private')); assert.ok(!JSON.stringify(phases).includes('never retained'));
});
test('provider hooks do not replace decorated gateways, guards or controllers', () => {
  const diagnostic = new TrackingDiagnostics(); const names = [], modules = {};
  for (const [service, methods] of [['WsSessionService', ['begin']], ['TripsService', ['updateDriverLocation']],
    ['BookingsService', ['updatePassengerLocation']], ['LocationHistoryService', ['recordDriverLocation', 'recordPassengerLocation']]]) {
    class Token {} Object.defineProperty(Token, 'name', { value: service });
    modules[service] = Token; Token.instance = Object.fromEntries(methods.map(method => [method, () => true]));
  }
  modules.appendLocationHistory = () => true;
  diagnostic.installProviders({ get(Token) { names.push(Token.name); return Token.instance; } }, () => modules);
  assert.deepEqual([...new Set(names)], ['WsSessionService', 'TripsService', 'BookingsService', 'LocationHistoryService']);
  assert.equal(modules.TripsService.instance.updateDriverLocation(), true);
});
test('GPS validation timing still invokes the exact validator and leaves other DTOs unmeasured', async () => {
  const diagnostic = new TrackingDiagnostics(); class Driver {} class Passenger {} class Other {}
  const error = new Error('private invalid input'); let calls = 0;
  const pipe = { transform(value, metadata) { assert.equal(this, pipe); calls++;
    if (metadata.metatype === Driver) throw error; return value; } };
  diagnostic.installValidation(pipe, Driver, Passenger);
  assert.throws(() => pipe.transform({}, { metatype: Driver }), e => e === error);
  const payload = {}; assert.equal(pipe.transform(payload, { metatype: Passenger }), payload);
  assert.equal(pipe.transform(payload, { metatype: Other }), payload);
  assert.equal(calls, 3);
  const phases = diagnostic.snapshot().phases;
  assert.equal(phases.driver_validation.cumulative.failed, 1); assert.equal(phases.passenger_validation.cumulative.count, 1);
});
