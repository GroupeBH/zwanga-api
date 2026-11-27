'use strict';
const { performance, PerformanceObserver, monitorEventLoopDelay } = require('node:perf_hooks');
const { freemem } = require('node:os');

const LIMIT = 12;
const PHASES = new Set(['setup', 'ramp', 'steady', 'soak', 'finish', 'drain', 'fault-recovery', 'completed']);
const phaseName = value => PHASES.has(value) ? value : 'setup';
const overlap = (a, b) => Math.max(0, Math.min(a.atMs + a.durationMs, b.atMs + b.durationMs) - Math.max(a.atMs, b.atMs));
function keepLargest(rows, row, key) {
  rows.push(row); rows.sort((a, b) => b[key] - a[key]); rows.length = Math.min(rows.length, LIMIT);
}

// Numeric aggregates and fixed-size incident lists only. No HTTP observer,
// payloads, request identifiers, tokens, SQL text or unbounded CPU profile.
class RuntimeDiagnostics {
  constructor() {
    this.lastIteration = null;
    this.gaps = []; this.gcEvents = []; this.samples = []; this.activities = [];
    this.gc = { count: 0, totalMs: 0, maxMs: 0 };
    this.peaks = { samples: 0, schedulerGapMs: 0, timerDelayMs: 0, cpuOneCorePercent: 0,
      eventLoopDelayMs: 0, eventLoopUtilization: 0, rssMiB: 0, heapUsedMiB: 0, minHostFreeMiB: null };
  }
  iteration(atMs, phase) {
    if (this.lastIteration !== null) {
      const durationMs = atMs - this.lastIteration;
      this.peaks.schedulerGapMs = Math.max(this.peaks.schedulerGapMs, durationMs);
      if (durationMs >= 100) keepLargest(this.gaps, { atMs: this.lastIteration, durationMs, phase: phaseName(phase) }, 'durationMs');
    }
    this.lastIteration = atMs;
  }
  recordGc(atMs, durationMs, kind) {
    this.gc.count++; this.gc.totalMs += durationMs; this.gc.maxMs = Math.max(this.gc.maxMs, durationMs);
    keepLargest(this.gcEvents, { atMs, durationMs, kind: Number.isFinite(kind) ? kind : 0 }, 'durationMs');
  }
  activity(name, atMs, durationMs) {
    if (!['health', 'report_write', 'presence'].includes(name)) throw new Error('Unknown generator activity');
    keepLargest(this.activities, { name, atMs, durationMs }, 'durationMs');
  }
  sample(value) {
    // Explicit copy prevents incidental runtime data leaking into the report.
    const row = Object.fromEntries(['atMs', 'durationMs', 'timerDelayMs', 'cpuOneCorePercent',
      'eventLoopDelayMs', 'eventLoopUtilization', 'rssMiB', 'heapUsedMiB', 'hostFreeMiB'].map(k => [k, value[k]]));
    if (Object.values(row).some(v => !Number.isFinite(v) || v < 0)) throw new Error('Invalid runtime observation');
    row.phase = phaseName(value.phase);
    this.peaks.samples++;
    for (const key of ['timerDelayMs', 'cpuOneCorePercent', 'eventLoopDelayMs', 'eventLoopUtilization', 'rssMiB', 'heapUsedMiB'])
      this.peaks[key] = Math.max(this.peaks[key], row[key]);
    this.peaks.minHostFreeMiB = Math.min(this.peaks.minHostFreeMiB ?? Infinity, row.hostFreeMiB);
    keepLargest(this.samples, row, 'timerDelayMs');
  }
  snapshot() {
    return structuredClone({ retainedIncidentsPerKind: LIMIT, peaks: this.peaks, gc: this.gc,
      longestSchedulerGaps: this.gaps.map(gap => ({ ...gap,
        // Intersection of retained observations, NOT a causal attribution or
        // total stop-the-world time (some GC work can run concurrently).
        recordedGcOverlapMs: this.gcEvents.reduce((sum, event) => sum + overlap(gap, event), 0),
        overlappingActivities: this.activities.filter(a => overlap(gap, a) > 0),
        overlappingSamples: this.samples.filter(s => overlap(gap, s) > 0),
      })), longestGcEvents: this.gcEvents, slowestTimerSamples: this.samples, longestActivities: this.activities });
  }
}

function observeGenerator(getPhase) {
  const diagnostics = new RuntimeDiagnostics(), start = performance.now(), period = 250;
  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  const consume = entries => {
    for (const e of entries) diagnostics.recordGc(e.startTime - start, e.duration, e.detail?.kind);
  };
  const observer = new PerformanceObserver(list => consume(list.getEntries()));
  observer.observe({ entryTypes: ['gc'] });
  let previousAt = start, previousCpu = process.cpuUsage(), previousElu = performance.eventLoopUtilization(), stopped = false;
  const sample = () => {
    const now = performance.now(), durationMs = now - previousAt;
    if (durationMs <= 0) return;
    const cpu = process.cpuUsage(), elu = performance.eventLoopUtilization();
    const deltaElu = performance.eventLoopUtilization(elu, previousElu), memory = process.memoryUsage();
    diagnostics.sample({ atMs: previousAt - start, durationMs, timerDelayMs: Math.max(0, durationMs - period),
      cpuOneCorePercent: ((cpu.user - previousCpu.user) + (cpu.system - previousCpu.system)) / (durationMs * 10),
      eventLoopDelayMs: histogram.max / 1e6, eventLoopUtilization: deltaElu.utilization,
      rssMiB: memory.rss / 2 ** 20, heapUsedMiB: memory.heapUsed / 2 ** 20, hostFreeMiB: freemem() / 2 ** 20,
      phase: getPhase() });
    histogram.reset(); previousAt = now; previousCpu = cpu; previousElu = elu;
  };
  const timer = setInterval(sample, period); timer.unref();
  return {
    iteration: now => diagnostics.iteration(now - start, getPhase()),
    activity: (name, at, duration) => diagnostics.activity(name, at - start, duration),
    snapshot: () => diagnostics.snapshot(),
    stop() {
      if (!stopped) { clearInterval(timer); sample(); consume(observer.takeRecords()); observer.disconnect(); histogram.disable(); stopped = true; }
      return diagnostics.snapshot();
    },
  };
}
module.exports = { RuntimeDiagnostics, observeGenerator };
