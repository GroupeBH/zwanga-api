import { DispatchDiagnostics } from './dispatch-diagnostics';

it('keeps bounded aggregate diagnostics, including failed attempts, with detached snapshots', async () => {
  const metrics = new DispatchDiagnostics();
  metrics.record('no_candidates'); metrics.record('no_candidates');
  metrics.duration('state', 1250); metrics.duration('state', 20);
  await expect(metrics.measure('discovery', async () => { throw new Error('timeout'); })).rejects.toThrow('timeout');
  const snapshot = metrics.snapshot();
  expect(snapshot.reasons).toEqual({ no_candidates: 2 });
  expect(snapshot.phases.state).toEqual({ count: 2, totalMs: 1270, maxMs: 1250, over250ms: 1, over1000ms: 1 });
  expect(snapshot.phases.discovery?.count).toBe(1);
  snapshot.reasons.no_candidates = 99; snapshot.phases.state!.count = 99;
  expect(metrics.snapshot().phases.state?.count).toBe(2);
  expect(metrics.snapshot().reasons.no_candidates).toBe(2);
});
