import { CoalescedRideProgress } from './coalesced-ride-progress';

describe('coalesced GPS progress', () => {
  const result = (tripId: string) => ({ tripId, events: [{ type: 'pickup' }] });
  it('paces spaced updates without returning a stale cached result or blocking another trip', async () => {
    jest.useFakeTimers({ now: 10000 });
    try {
      const queue = new CoalescedRideProgress<ReturnType<typeof result>>(1000);
      const work = jest.fn(async () => result('one'));
      await queue.run('one', work);
      await jest.advanceTimersByTimeAsync(100);
      const next = queue.run('one', work);
      expect(work).toHaveBeenCalledTimes(1);
      expect(await queue.run('two', async () => result('two'))).toEqual(
        result('two'),
      );
      await jest.advanceTimersByTimeAsync(899);
      expect(work).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1);
      expect(await next).toEqual(result('one'));
      expect(work).toHaveBeenCalledTimes(2);
      await jest.advanceTimersByTimeAsync(1000);
      expect((queue as any).trips.size).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
  it('runs one active plus one fresh queued evaluation for a burst, without duplicating events', async () => {
    const queue = new CoalescedRideProgress<ReturnType<typeof result>>();
    let resolve!: (value: ReturnType<typeof result>) => void;
    const first = jest.fn(
      () =>
        new Promise<ReturnType<typeof result>>((done) => {
          resolve = done;
        }),
    );
    const next = jest.fn(async () => result('trip'));
    const active = queue.run('trip', first);
    const followers = Array.from({ length: 100 }, () =>
      queue.run('trip', next),
    );
    expect(first).toHaveBeenCalledTimes(1);
    expect(next).not.toHaveBeenCalled();
    resolve(result('trip'));
    const results = await Promise.all([active, ...followers]);
    expect(next).toHaveBeenCalledTimes(1);
    expect(results.filter((value) => value.events.length)).toHaveLength(2);
    await queue.run('trip', next);
    expect(next).toHaveBeenCalledTimes(2);
  });
  it('does not block other trips and recovers after a failure', async () => {
    const queue = new CoalescedRideProgress<ReturnType<typeof result>>();
    let reject!: (error: Error) => void;
    const first = queue.run(
      'one',
      () =>
        new Promise((_yes, no) => {
          reject = no;
        }),
    );
    const failure = expect(first).rejects.toThrow('failed');
    const next = queue.run('one', async () => result('one'));
    expect(await queue.run('two', async () => result('two'))).toEqual(
      result('two'),
    );
    reject(new Error('failed'));
    await failure;
    expect(await next).toEqual(result('one'));
  });
});
