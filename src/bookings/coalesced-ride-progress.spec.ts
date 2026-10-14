import { CoalescedRideProgress } from './coalesced-ride-progress';

describe('coalesced GPS progress', () => {
  const result = (tripId: string) => ({ tripId, events: [{ type: 'pickup' }] });
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
