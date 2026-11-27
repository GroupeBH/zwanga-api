import { AsyncLocalStorage } from 'node:async_hooks';
import { ServiceUnavailableException } from '@nestjs/common';
import { receiptAdmission } from './receipt-admission';
import { dispatchResponseAdmission } from './dispatch-response-admission';
import { DriverDispatchService } from './dispatch.service';

const hold = () => { let release!: () => void;
  const promise = new Promise<void>(r => { release = r; }); return { promise, release }; };
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };

describe('notification receipt SQL admission', () => {
  it('shares two slots per data source, independent of responses and other sources', () => {
    const db = { options: { extra: { max: 10 } } };
    expect(receiptAdmission(db)).toBe(receiptAdmission(db));
    expect(receiptAdmission(db)).not.toBe(dispatchResponseAdmission(db));
    expect(receiptAdmission(db).capacity).toBe(2);
    expect(receiptAdmission({ options: { poolSize: 2 } }).capacity).toBe(1);
    expect(receiptAdmission({ options: { poolSize: 100 } }).capacity).toBe(2);
    expect(receiptAdmission({})).not.toBe(receiptAdmission(db));
    expect(() => receiptAdmission({ options: { poolSize: NaN } })).toThrow();
  });
  it('does not acquire a connection before admission or acknowledge before commit', async () => {
    const pending = hold(), committed = hold(), query = jest.fn().mockResolvedValue([]);
    const db = { options: { poolSize: 10 }, transaction: jest.fn(async work => {
      await pending.promise; const result = await work({ query });
      await committed.promise; return result;
    }) };
    const service = new DriverDispatchService(db as any, {} as any, {} as any);
    const settled = jest.fn();
    const jobs = [0, 1, 2].map(i => service.acknowledgeNotification('user', String(i)).then(settled));
    await flush(); expect(db.transaction).toHaveBeenCalledTimes(2);
    expect(query).not.toHaveBeenCalled(); expect(receiptAdmission(db).snapshot().waiting).toBe(1);
    pending.release(); await flush();
    expect(settled).not.toHaveBeenCalled(); expect(db.transaction).toHaveBeenCalledTimes(2);
    committed.release(); await Promise.all(jobs);
    expect(db.transaction).toHaveBeenCalledTimes(3); expect(receiptAdmission(db).snapshot().active).toBe(0);
  });
  it('refuses only unstarted work with a retryable error, never a false received result', async () => {
    jest.useFakeTimers();
    try {
      const gate = receiptAdmission({ options: { poolSize: 1 } }), pending = hold(), sql = jest.fn();
      const started = gate.run(() => pending.promise);
      const waiting = Array.from({ length: 32 }, () => gate.run(sql).catch(e => e));
      const full = await gate.run(sql).catch(e => e);
      expect(full).toBeInstanceOf(ServiceUnavailableException);
      if (!(full instanceof ServiceUnavailableException)) throw new Error('Missing admission refusal');
      expect(full.getResponse()).toMatchObject({ code: 'NOTIFICATION_RECEIPT_BUSY', retryable: true });
      await jest.advanceTimersByTimeAsync(800);
      expect((await Promise.all(waiting)).every(e => e instanceof ServiceUnavailableException && e.getStatus() === 503)).toBe(true);
      expect(sql).not.toHaveBeenCalled(); expect(gate.snapshot().active).toBe(1);
      pending.release(); await started;
      expect(gate.snapshot().rejected).toEqual({ full: 1, expired: 32 });
    } finally { jest.useRealTimers(); }
  });
  it('preserves per-caller tracing and rejects original commit failures without retry', async () => {
    const gate = receiptAdmission({ options: { poolSize: 1 } }), ctx = new AsyncLocalStorage<string>(), pending = hold();
    const first = ctx.run('first', () => gate.run(() => pending.promise));
    const next = ctx.run('next', () => gate.run(async () => ctx.getStore()));
    pending.release(); await first; expect(await next).toBe('next');
    const error = new Error('commit failure'), write = jest.fn().mockRejectedValue(error);
    await expect(gate.run(write)).rejects.toBe(error); expect(write).toHaveBeenCalledTimes(1);
    expect(gate.snapshot().active).toBe(0);
  });
});
