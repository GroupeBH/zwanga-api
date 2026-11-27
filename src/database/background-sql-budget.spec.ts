import { AsyncLocalStorage } from 'node:async_hooks';
import { backgroundSql, backgroundSqlBudget, BackgroundSqlBudget, SqlAdmissionDeferred } from './background-sql-budget';
const deferred = () => { let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };

describe('shared background SQL admission', () => {
  it('preserves each queued task context across different lanes', async () => {
    const context = new AsyncLocalStorage<string>(), gate = new BackgroundSqlBudget(1), held = deferred();
    const first = context.run('dispatch', () => gate.run('dispatch', () => held.promise));
    const pending = (['delivery', 'progress', 'maintenance'] as const).map(lane => context.run(lane,
      () => gate.run(lane, async () => context.getStore())));
    await flush(); held.release(); await first;
    expect(await Promise.all(pending)).toEqual(['delivery', 'progress', 'maintenance']);
    expect(context.getStore()).toBeUndefined();
  });
  it('shares capacity across managers, leaves foreground headroom, isolates different databases', () => {
    const db = { options: { extra: { max: 10 } } };
    expect(backgroundSqlBudget(db).capacity).toBe(6);
    expect(backgroundSqlBudget({ connection: db })).toBe(backgroundSqlBudget(db));
    expect(backgroundSqlBudget({ options: { extra: { max: 3 } } }).capacity).toBe(1);
    expect(backgroundSqlBudget({})).not.toBe(backgroundSqlBudget(db));
  });
  it('acquires before work and keeps FIFO without starving any lane', async () => {
    const gate = new BackgroundSqlBudget(1), held = deferred(), started: string[] = [];
    const first = gate.run('dispatch', () => held.promise);
    const requests = ['maintenance', 'dispatch', 'delivery', 'progress', 'delivery', 'progress'] as const;
    const pending = requests.map((lane, i) => gate.run(lane, async () => { started.push(lane + i); }));
    await flush(); expect(started).toEqual([]); expect(gate.snapshot().waiting).toBe(6);
    held.release(); await Promise.all([first, ...pending]);
    expect(started).toEqual(['progress3', 'delivery2', 'dispatch1', 'progress5', 'delivery4', 'maintenance0']);
    expect(gate.snapshot().active).toBe(0); expect(gate.snapshot().waiting).toBe(0);
    expect(gate.snapshot().lanes.maintenance.total.count).toBe(1);
  });
  it('limits total occupancy across unrelated modules and releases SQL failures and synchronous throws', async () => {
    const gate = new BackgroundSqlBudget(2), held = deferred(); let active = 0, peak = 0;
    const work = () => gate.run('progress', async () => {
      active++; peak = Math.max(peak, active); await held.promise; active--; throw new Error('rollback');
    }).catch(error => error.message);
    const pending = [work(), work(), work()]; await flush(); expect(active).toBe(2);
    held.release(); expect(await Promise.all(pending)).toEqual(['rollback', 'rollback', 'rollback']);
    expect(peak).toBe(2);
    await expect(gate.run('dispatch', () => { throw new Error('before SQL'); })).rejects.toThrow('before SQL');
    expect(gate.snapshot().active).toBe(0);
  });
  it('bounds waiting memory, expires only unstarted work, and never cancels an executing commit', async () => {
    jest.useFakeTimers();
    try {
      const gate = new BackgroundSqlBudget(1, 1, 100), held = deferred(), sql = jest.fn();
      const running = gate.run('dispatch', () => held.promise);
      const queued = gate.run('delivery', sql).catch(error => error);
      await expect(gate.run('maintenance', sql)).rejects.toBeInstanceOf(SqlAdmissionDeferred);
      await jest.advanceTimersByTimeAsync(150);
      expect(await queued).toBeInstanceOf(SqlAdmissionDeferred); expect(sql).not.toHaveBeenCalled();
      expect(gate.snapshot().active).toBe(1); expect(gate.snapshot().waiting).toBe(0);
      held.release(); await running;
      await expect(gate.run('progress', async () => 'committed')).resolves.toBe('committed');
      expect(gate.snapshot().lanes.delivery.deferred).toBe(1);
    } finally { jest.useRealTimers(); }
  });
  it.each([true, false])('never queues an already bound query runner (transaction active=%s)', async isTransactionActive => {
    const db = { options: { extra: { max: 1 } } }, held = deferred();
    const first = backgroundSql(db, 'dispatch', () => held.promise);
    await expect(backgroundSql({ connection: db, queryRunner: { isTransactionActive } },
      'progress', async () => 'same connection')).resolves.toBe('same connection');
    held.release(); await first;
  });
  it('does not execute expired queued work when the timer was delayed by an event-loop stall', async () => {
    let now = 0;
    const gate = new BackgroundSqlBudget(1, 2, 2000, () => now), held = deferred(), sql = jest.fn();
    const running = gate.run('dispatch', () => held.promise);
    const waiting = gate.run('delivery', sql).catch(error => error);
    await flush(); now = 2100; held.release(); await running;
    expect(await waiting).toBeInstanceOf(SqlAdmissionDeferred);
    expect(sql).not.toHaveBeenCalled(); expect(gate.snapshot().active).toBe(0);
    expect(gate.snapshot().lanes.delivery.wait.maxMs).toBe(2100);
  });
  it('exports fixed aggregates, without SQL, parameters or identifiers', async () => {
    const gate = new BackgroundSqlBudget(2);
    for (let i = 0; i < 200; i++) await gate.run('delivery', async () => 'private-user-token');
    const snap = gate.snapshot(); expect(snap.lanes.delivery.completed).toBe(200);
    expect(JSON.stringify(snap)).not.toContain('private-user');
    expect(snap.lanes.delivery.wait.count).toBe(200); expect(snap.lanes.delivery.total.count).toBe(200);
  });
});
