'use strict';
const { Session } = require('node:inspector');
const { performance } = require('node:perf_hooks');
const WINDOW_MS = 180_000;

function safeFrame(frame) {
  return { file: String(frame.url ?? '').replaceAll('\\', '/').split('/').slice(-2).join('/'),
    line: frame.lineNumber + 1, function: frame.functionName || '(anonymous)' };
}

// Local bench only, one bounded window. No debug port, SQL, identifiers or
// arguments are exported. Raw samples are discarded after aggregation.
function summarize(profile) {
  const nodes = new Map(profile.nodes.map(n => [n.id, n]));
  const parents = new Map();
  for (const node of nodes.values()) for (const child of node.children ?? []) parents.set(child, node.id);
  const groups = new Map();
  const longest = [];
  let sampledUs = 0;
  for (let i = 0; i < (profile.samples?.length ?? 0); i++) {
    const us = profile.timeDeltas?.[i] ?? 0;
    sampledUs += us;
    const node = nodes.get(profile.samples[i]);
    if (!node) continue;
    const frame = safeFrame(node.callFrame);
    const key = `${frame.file}:${frame.line}:${frame.function}`;
    const row = groups.get(key) ?? { ...frame, samples: 0, selfMs: 0 };
    row.samples++; row.selfMs += us / 1000; groups.set(key, row);
    if (longest.length < 12 || us > longest.at(-1).us) {
      longest.push({ id: node.id, us, offsetUs: sampledUs });
      longest.sort((a, b) => b.us - a.us); longest.length = Math.min(longest.length, 12);
    }
  }
  return { semantics: 'sampled wall time, including idle/GC; not exact CPU time or a causal attribution',
    durationMs: (profile.endTime - profile.startTime) / 1000, sampledMs: sampledUs / 1000,
    longestIntervals: longest.map(sample => {
      const stack = [], visited = new Set(); let id = sample.id;
      while (nodes.has(id) && !visited.has(id) && stack.length < 12) {
        visited.add(id); stack.push(safeFrame(nodes.get(id).callFrame)); id = parents.get(id);
      }
      return { endOffsetMs: sample.offsetUs / 1000, intervalMs: sample.us / 1000, stack };
    }),
    intervalSemantics: 'stack sampled at interval end, leaf first; a long interval may be scheduler delay, not work in this stack',
    topFrames: [...groups.values()].sort((a, b) => b.selfMs - a.selfMs).slice(0, 40) };
}
class CpuDiagnostics {
  constructor(makeSession = () => new Session()) { this.state = 'not_started'; this.makeSession = makeSession; }
  async start() {
    if (this.state !== 'not_started') return;
    this.state = 'starting'; this.session = this.makeSession();
    try {
      this.session.connect();
      this.post = (method, params = {}) => new Promise((resolve, reject) =>
        this.session.post(method, params, (error, result) => error ? reject(error) : resolve(result)));
      await this.post('Profiler.enable');
      await this.post('Profiler.setSamplingInterval', { interval: 2000 });
      this.startRequestedAt = new Date().toISOString();
      const start = performance.now();
      await this.post('Profiler.start'); this.state = 'recording';
      this.startOverheadMs = performance.now() - start;
      this.timer = setTimeout(() => void this.stop().catch(() => {}), WINDOW_MS); this.timer.unref();
    } catch (error) { this.state = 'failed'; this.session.disconnect(); throw error; }
  }
  stop() {
    if (this.stopping) return this.stopping;
    if (this.state !== 'recording') return Promise.resolve();
    this.stopping = (async () => {
      clearTimeout(this.timer);
      this.stopRequestedAt = new Date().toISOString();
      const start = performance.now();
      try { this.result = summarize((await this.post('Profiler.stop')).profile); this.state = 'completed'; }
      catch (error) { this.state = 'failed'; throw error; }
      finally { this.stopOverheadMs = performance.now() - start; this.session.disconnect(); }
    })();
    return this.stopping;
  }
  snapshot() { return { state: this.state, windowLimitSeconds: WINDOW_MS / 1000,
    startRequestedAt: this.startRequestedAt, startOverheadMs: this.startOverheadMs,
    stopRequestedAt: this.stopRequestedAt, stopOverheadMs: this.stopOverheadMs, ...this.result }; }
}
module.exports = { CpuDiagnostics, summarize };
