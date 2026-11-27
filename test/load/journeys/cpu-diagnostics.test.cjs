'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { summarize, CpuDiagnostics } = require('./cpu-diagnostics.cjs');
test('CPU sampling is opt-in and cannot select a target server', () => {
  const { execFileSync } = require('node:child_process');
  const { join } = require('node:path');
  const plan = flags => JSON.parse(execFileSync(process.execPath,
    [join(__dirname, 'run.cjs'), 'stage-500-mixed', ...flags], { encoding: 'utf8' }));
  assert.equal(plan([]).profileCpu, false);
  const enabled = plan(['--profile-cpu']);
  assert.equal(enabled.profileCpu, true); assert.equal(enabled.targetPolicy, 'fresh-local-resources-only');
  assert.equal(enabled.capacityValidated, false);
});
test('exports bounded function aggregates, not raw CPU samples or absolute file paths', () => {
  const nodes = Array.from({ length: 60 }, (_, i) => ({ id: i, callFrame: {
    functionName: `fn${i}`, url: `file:///private/workspace/src/module/file${i}.js`, lineNumber: i } }));
  const result = summarize({ nodes, startTime: 0, endTime: 120000,
    samples: nodes.map(n => n.id), timeDeltas: nodes.map(() => 2000) });
  assert.equal(result.topFrames.length, 40); assert.equal(result.sampledMs, 120);
  assert.equal(result.durationMs, 120); assert.equal(result.topFrames[0].file, 'module/file0.js');
  assert.ok(!JSON.stringify(result).includes('private')); assert.ok(!Object.hasOwn(result, 'nodes'));
  assert.equal(result.longestIntervals.length, 12);
});

test('long samples retain bounded ancestry and timing without paths or raw sample IDs', () => {
  const nodes = Array.from({ length: 20 }, (_, i) => ({ id: i, children: [i + 1], callFrame: {
    functionName: `fn${i}`, url: 'C:\\private\\src\\module\\file.js', lineNumber: i } }));
  const result = summarize({ nodes, startTime: 0, endTime: 410000,
    samples: [19, 999, 18], timeDeltas: [2000, 8000, 400000] });
  const interval = result.longestIntervals[0];
  assert.equal(interval.intervalMs, 400); assert.equal(interval.endOffsetMs, 410);
  assert.equal(interval.stack.length, 12); assert.equal(interval.stack[0].function, 'fn18');
  assert.equal(interval.stack[1].function, 'fn17');
  assert.equal(interval.stack[0].file, 'module/file.js');
  assert.ok(!JSON.stringify(result).includes('private'));
  assert.ok(!Object.hasOwn(interval, 'id'));
});
test('local profiler has no listening port and can be stopped repeatedly', async () => {
  const profiler = new CpuDiagnostics();
  await profiler.stop(); assert.equal(profiler.snapshot().state, 'not_started');
  await profiler.start(); await profiler.start();
  await new Promise(resolve => setTimeout(resolve, 20));
  await Promise.all([profiler.stop(), profiler.stop()]);
  assert.equal(profiler.snapshot().state, 'completed');
  assert.equal(profiler.snapshot().windowLimitSeconds, 180);
  assert.ok(profiler.snapshot().startOverheadMs >= 0);
  assert.ok(profiler.snapshot().stopOverheadMs >= 0);
  assert.ok(Date.parse(profiler.snapshot().stopRequestedAt) >= Date.parse(profiler.snapshot().startRequestedAt));
});
test('a failed profiler startup closes its session and remains explicitly failed', async () => {
  let disconnected = 0;
  const profiler = new CpuDiagnostics(() => ({ connect() {}, disconnect() { disconnected++; },
    post(method, params, cb) { cb(new Error('diagnostic unavailable')); } }));
  await assert.rejects(profiler.start(), /diagnostic unavailable/);
  await profiler.stop();
  assert.equal(disconnected, 1); assert.equal(profiler.snapshot().state, 'failed');
});
