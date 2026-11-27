'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { recoverTrackingState } = require('./recovery.cjs');
const { gps } = require('./transport.cjs');
const { profile, describe } = require('./profile.cjs');
const { containerArgs } = require('./container-child.cjs');
const { exerciseRecovery } = require('./resilience.cjs');
const { replayDelayedGps } = require('./delayed-gps.cjs');
const { Resources } = require('./resources.cjs');
const socket = response => ({ timeout: () => ({ emitWithAck: async () => response }) });

test('recovery requires exact scoped committed terminal state, not just a positive response', async () => {
  const payload = { tripId: 'trip', bookingId: 'booking' };
  const state = { ...payload, tripStatus: 'completed', bookingStatus: 'completed', droppedOff: true };
  await recoverTrackingState(socket({ success: true, state }), payload, 1);
  for (const response of [{}, { success: false, state }, { success: true, state: { ...state, tripId: 'other' } },
    { success: true, state: { ...state, bookingId: 'other' } }, { success: true, state: { ...state, droppedOff: false } },
    { success: true, state: { ...state, bookingStatus: 'accepted' } }])
    await assert.rejects(recoverTrackingState(socket(response), payload, 1));
  await assert.rejects(recoverTrackingState(socket({ success: true, state: { tripId: 'trip', tripStatus: 'ongoing' } }), { tripId: 'trip' }, 1));
});

test('terminal GPS never becomes accepted and only triggers recovery on a matching structured refusal', async () => {
  const data = { tripId: 'trip', recordedAt: '2026-11-22T12:00:00Z' }, events = [];
  const s = { timeout: () => ({ emitWithAck: async (event) => {
    events.push(event);
    return event === 'get_tracking_state' ? { success: true, state: { tripId: 'trip', tripStatus: 'completed' } }
      : { ...data, success: false, status: 'state_changed', code: 'TRACKING_STATE_CHANGED' };
  } }) };
  assert.equal((await gps(s, 'driver_location_update', data, 1)).terminal, true);
  assert.deepEqual(events, ['driver_location_update', 'get_tracking_state']);
  await assert.rejects(gps(socket({ ...data, tripId: 'other', success: false, status: 'state_changed', code: 'TRACKING_STATE_CHANGED' }), 'driver_location_update', data, 1));
});

test('each independent stage includes demand and all driver alerts with session headroom', () => {
  for (const n of [100, 250, 500, 750, 1000]) {
    const p = profile(`stage-${n}`), d = describe(p);
    assert.equal(p.stages.length, 1); assert.equal(p.requests, n);
    assert.equal(d.totalSockets, 6 * n); assert.ok(d.plannedSocketCeilingPerReplica <= 1600);
  }
  const capacity = profile('capacity');
  assert.ok(capacity.renewSeconds < 1800);
  assert.equal(capacity.requests, capacity.stageRequests.reduce((a, b) => a + b, 0) + 3 * 1000);
});

test('container launch is digest-pinned, limited, read-only and cannot select an unrelated name', () => {
  const args = containerArgs('sha256:' + 'a'.repeat(64), 'zwanga-journey-00000000-0000-4000-8000-000000000000', '/tmp/owned.env');
  for (const option of ['--read-only', '--cap-drop', '--cpus', '--memory', '--memory-swap', '--pids-limit']) assert.ok(args.includes(option));
  assert.equal(args[args.indexOf('--cpus') + 1], '0.5'); assert.equal(args[args.indexOf('--memory') + 1], '1024m');
  assert.ok(!args.includes('--privileged')); assert.ok(!args.includes('-v'));
  assert.throws(() => containerArgs('latest', 'production', '/tmp/x'));
});

test('fault injection is refused without explicit profile and bounded owned resources', async () => {
  const resources = new Resources('/unused');
  await assert.rejects(resources.restartBackend(0));
  await assert.rejects(resources.interruptRedis(1000));
  resources.profile = { resilience: true }; resources.redisProxy = {};
  for (const ms of [-1, 0, 3001, Infinity, NaN]) await assert.rejects(resources.interruptRedis(ms));
  await assert.rejects(exerciseRecovery({}, [], [], { resilience: false }));
});

test('delayed GPS probes must be superseded, never silently accepted', async () => {
  const expected = { tripId: 'trip', coordinates: [15.31, -4.3], recordedAt: '2026-11-22T12:00:10Z' };
  const s = status => ({ timeout: () => ({ emitWithAck: async (_event, data) => ({ ...data, success: true, status }) }) });
  const row = { tripId: 'trip', bookingId: 'booking', expected, driverSocket: s('superseded'), passengerSocket: s('superseded') };
  assert.deepEqual(await replayDelayedGps(row, 1), { replayed: 2, superseded: 2 });
  await assert.rejects(replayDelayedGps({ ...row, driverSocket: s('accepted') }, 1));
});

test('unexpected GPS replies remain failures with bounded non-sensitive diagnostics', async () => {
  const data = { tripId: 'trip', bookingId: 'booking', recordedAt: '2026-11-22T12:00:00Z' };
  for (const [ack, category] of [
    [{ ...data, success: true, status: 'superseded' }, 'superseded'],
    [{ ...data, tripId: 'untrusted-id', success: true, status: 'accepted' }, 'correlation_mismatch'],
    [{ ...data, success: false, message: 'untrusted-secret' }, 'rejected'],
    [{ ...data, success: true, status: 'untrusted-secret' }, 'unknown_status'],
    [null, 'missing_reply'],
  ]) {
    await assert.rejects(gps(socket(ack), 'passenger_location_update', data, 1), error => {
      assert.equal(error.message, 'GPS acknowledgement rejected or mismatched: ' + category);
      assert.ok(!error.message.includes('untrusted'));
      return true;
    });
  }
});
