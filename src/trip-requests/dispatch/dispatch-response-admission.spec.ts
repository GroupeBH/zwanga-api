import { ServiceUnavailableException } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import { DispatchResponseAdmission, dispatchResponseAdmission } from './dispatch-response-admission';
import { DriverDispatchService } from './dispatch.service';

const deferred = () => { let release!: () => void;
  const promise = new Promise<void>(r => { release = r; }); return { promise, release }; };
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };

describe('dispatch response admission', () => {
  it('preserves the queued request context instead of inheriting the releasing request', async () => {
    const context = new AsyncLocalStorage<string>(), gate = new DispatchResponseAdmission(1), held = deferred();
    const first = context.run('first', () => gate.run(() => held.promise));
    const queued = context.run('queued', () => gate.run(async () => context.getStore()));
    await flush(); held.release(); await first;
    expect(await queued).toBe('queued');
    expect(context.getStore()).toBeUndefined();
  });
  it('shares a bounded budget per database, never expands with a larger pool', () => {
    const db = { options: { extra: { max: 10 } } };
    expect(dispatchResponseAdmission(db)).toBe(dispatchResponseAdmission(db));
    expect(dispatchResponseAdmission(db).capacity).toBe(2);
    expect(dispatchResponseAdmission({ options: { extra: { max: 100 } } }).capacity).toBe(2);
    expect(dispatchResponseAdmission({ options: { poolSize: 3 } }).capacity).toBe(1);
    expect(dispatchResponseAdmission({})).not.toBe(dispatchResponseAdmission(db));
  });
  it('queues FIFO before invoking any SQL and retains results/errors unchanged', async () => {
    const gate = new DispatchResponseAdmission(2), held = deferred(), started: number[] = [];
    const jobs = [0, 1, 2, 3].map(i => gate.run(async () => {
      started.push(i); await held.promise; return i;
    }));
    await flush(); expect(started).toEqual([0, 1]); expect(gate.snapshot().waiting).toBe(2);
    held.release(); expect(await Promise.all(jobs)).toEqual([0, 1, 2, 3]);
    expect(started).toEqual([0, 1, 2, 3]); expect(gate.snapshot().peakActive).toBe(2);
    const error = new Error('original SQL failure');
    await expect(gate.run(() => { throw error; })).rejects.toBe(error);
    expect(gate.snapshot().active).toBe(0);
    expect(JSON.stringify(gate.snapshot())).not.toContain(error.message);
  });
  it('refuses overflow and expires only unstarted work, never an executing commit', async () => {
    jest.useFakeTimers();
    try {
      const gate = new DispatchResponseAdmission(1, 1, 100), held = deferred(), sql = jest.fn();
      const executing = gate.run(() => held.promise);
      const queued = gate.run(sql).catch(e => e);
      await expect(gate.run(sql)).rejects.toBeInstanceOf(ServiceUnavailableException);
      await jest.advanceTimersByTimeAsync(200);
      const error = await queued;
      if (!(error instanceof ServiceUnavailableException)) throw new Error('Missing admission refusal');
      expect(error.getStatus()).toBe(503);
      expect(error.getResponse()).toMatchObject({ code: 'DISPATCH_RESPONSE_BUSY' });
      expect(sql).not.toHaveBeenCalled(); expect(gate.snapshot().active).toBe(1);
      held.release(); await executing;
      expect(gate.snapshot().rejected).toEqual({ full: 1, expired: 1 });
    } finally { jest.useRealTimers(); }
  });
  it('does not execute expired work when a stalled event loop delays the timeout', async () => {
    let now = 0;
    const gate = new DispatchResponseAdmission(1, 2, 100, () => now), held = deferred(), sql = jest.fn();
    const executing = gate.run(() => held.promise), queued = gate.run(sql).catch(e => e);
    now = 100; held.release(); await executing;
    expect(await queued).toBeInstanceOf(ServiceUnavailableException);
    expect(sql).not.toHaveBeenCalled(); expect(gate.snapshot().waiting).toBe(0);
    await expect(gate.run(async () => 'fresh')).resolves.toBe('fresh');
  });
  it('releases admission before post-commit Redis/notification work and holds queued SQL reads', async () => {
    const db = {}, config = { get: () => 'true' }, held = deferred(), external = deferred();
    const notifications = { dispatchUrgentNotifications: jest.fn().mockResolvedValue(undefined) };
    const sequential = { requestReleased: jest.fn(() => external.promise), advance: jest.fn() };
    const service = new DriverDispatchService(db as any, config as any, notifications as any, undefined, sequential as any);
    const commit = jest.spyOn(service as any, 'commitResponse').mockImplementation(async () => {
      await held.promise; return { requestId: 'private-request', status: 'accepted' };
    });
    const jobs = [1, 2, 3].map(i => service.respond('driver', String(i), 'accept'));
    await flush(); expect(commit).toHaveBeenCalledTimes(2);
    held.release(); await flush();
    expect(commit).toHaveBeenCalledTimes(3); expect(dispatchResponseAdmission(db).snapshot().active).toBe(0);
    expect(notifications.dispatchUrgentNotifications).not.toHaveBeenCalled();
    external.release(); await Promise.all(jobs);
    expect(notifications.dispatchUrgentNotifications).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(dispatchResponseAdmission(db).snapshot())).not.toContain('private-request');
  });
});
