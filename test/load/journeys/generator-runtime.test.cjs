'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { RuntimeDiagnostics, observeGenerator } = require('./generator-runtime.cjs');

test('generator incidents correlate measured overlap without claiming a cause', () => {
  const d = new RuntimeDiagnostics();
  d.iteration(0, 'ramp'); d.iteration(10, 'ramp'); d.iteration(810, 'ramp');
  d.recordGc(5, 20, 1); d.recordGc(900, 50, 1);
  d.activity('health', 10, 140); d.activity('report_write', 150, 3);
  const snap = d.snapshot();
  assert.equal(snap.peaks.schedulerGapMs, 800);
  assert.equal(snap.longestSchedulerGaps[0].recordedGcOverlapMs, 15);
  assert.deepEqual(snap.longestSchedulerGaps[0].overlappingActivities.map(a => a.name), ['health', 'report_write']);
  assert.deepEqual(snap.gc, { count: 2, totalMs: 70, maxMs: 50 });
  snap.longestSchedulerGaps[0].durationMs = 0;
  assert.equal(d.snapshot().longestSchedulerGaps[0].durationMs, 800);
});

test('runtime observations stay bounded and omit arbitrary fields and phase labels', () => {
  const d = new RuntimeDiagnostics();
  for (let i = 0; i < 1000; i++) {
    d.iteration(i * 200, 'private-id'); d.recordGc(i * 200, i, 1); d.activity('health', i * 200, i);
    d.sample({ atMs: i * 200, durationMs: 200, timerDelayMs: i, cpuOneCorePercent: 5,
      eventLoopDelayMs: 40, eventLoopUtilization: .1, rssMiB: 60, heapUsedMiB: 30, hostFreeMiB: 2000,
      phase: 'private-id', token: 'private-token' });
  }
  const snap = d.snapshot();
  for (const key of ['longestSchedulerGaps', 'longestGcEvents', 'slowestTimerSamples', 'longestActivities'])
    assert.equal(snap[key].length, 12);
  assert.equal(snap.peaks.samples, 1000); assert.equal(snap.gc.count, 1000);
  assert.equal(snap.peaks.minHostFreeMiB, 2000); assert.equal(snap.peaks.timerDelayMs, 999);
  assert.ok(!JSON.stringify(snap).includes('private-'));
  assert.throws(() => d.activity('private-id', 0, 5), /Unknown/);
  assert.throws(() => d.sample({}), /Invalid/);
});

test('live observer stops idempotently and keeps a serializable numeric snapshot', async () => {
  const probe = observeGenerator(() => 'steady');
  try {
    await new Promise(resolve => setTimeout(resolve, 270));
    const snap = probe.stop();
    assert.ok(snap.peaks.samples >= 1);
    assert.ok(snap.peaks.rssMiB > 0);
    assert.ok(Number.isFinite(snap.peaks.eventLoopDelayMs));
    assert.deepEqual(JSON.parse(JSON.stringify(snap)), snap);
    assert.deepEqual(probe.stop(), snap);
  } finally { probe.stop(); }
});
