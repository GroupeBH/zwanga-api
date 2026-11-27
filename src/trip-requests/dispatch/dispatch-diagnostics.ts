export type DispatchReason = 'inactive' | 'duplicate' | 'local_capacity' | 'closed' | 'recovery'
  | 'live_window' | 'fairness_yield' | 'redis_contention' | 'discovery_throttled'
  | 'no_candidates' | 'reservation_race' | 'request_changed' | 'offered' | 'sql_deferred' | 'sql_pressure' | 'error';
type Phase = 'state' | 'discovery' | 'reservation' | 'redis' | 'attempt';
type Timing = { count: number; totalMs: number; maxMs: number; over250ms: number; over1000ms: number };

/** Bounded aggregate diagnostics: no driver/request identifiers, coordinates or
 * payloads, and no additional SQL. Reasons are observations, not inferred CPU. */
export class DispatchDiagnostics {
  private readonly reasons: Partial<Record<DispatchReason, number>> = {};
  private readonly phases: Partial<Record<Phase, Timing>> = {};
  record(reason: DispatchReason) { this.reasons[reason] = (this.reasons[reason] ?? 0) + 1; }
  duration(phase: Phase, ms: number) {
    const row = this.phases[phase] ??= { count: 0, totalMs: 0, maxMs: 0, over250ms: 0, over1000ms: 0 };
    row.count++; row.totalMs += ms; row.maxMs = Math.max(row.maxMs, ms);
    if (ms >= 250) row.over250ms++;
    if (ms >= 1000) row.over1000ms++;
  }
  async measure<T>(phase: Phase, run: () => Promise<T>): Promise<T> {
    const at = performance.now();
    try { return await run(); } finally { this.duration(phase, performance.now() - at); }
  }
  snapshot() { return { reasons: { ...this.reasons }, phases: structuredClone(this.phases) }; }
}
