import { ProviderSingleFlight, withProviderDeadline } from './provider-work';

describe('bounded provider work', () => {
  it('coalesces identical work and releases capacity after failures', async () => {
    const flights = new ProviderSingleFlight();
    let release!: () => void;
    const work = jest.fn(() => new Promise<void>(resolve => { release = resolve; }));
    const first = flights.run('a', work), second = flights.run('a', work);
    expect(first).toBe(second);
    await Promise.resolve(); release(); await first;
    expect(work).toHaveBeenCalledTimes(1);
    await expect(flights.run('a', async () => { throw new Error('failed'); })).rejects.toThrow('failed');
    await expect(flights.run('a', async () => 3)).resolves.toBe(3);
  });
  it('bounds distinct concurrent calls instead of retaining an unbounded map', async () => {
    const flights = new ProviderSingleFlight(), pending: Promise<unknown>[] = [];
    let release!: () => void;
    const work = new Promise<void>(resolve => { release = resolve; });
    for (let i=0; i<64; i++) pending.push(flights.run(String(i), () => work));
    await expect(flights.run('overflow', () => work)).rejects.toMatchObject({ status: 503 });
    release(); await Promise.all(pending);
    await expect(flights.run('new', async () => 1)).resolves.toBe(1);
  });
  it('aborts provider I/O on the overall deadline and clears its timer on success', async () => {
    jest.useFakeTimers();
    try {
      let signal!: AbortSignal;
      const work = withProviderDeadline(50, async s => { signal=s; return new Promise(() => {}); });
      const failure = expect(work).rejects.toThrow('PROVIDER_BUDGET_EXHAUSTED');
      await jest.advanceTimersByTimeAsync(50); await failure;
      expect(signal.aborted).toBe(true);
      await expect(withProviderDeadline(50, async () => 1)).resolves.toBe(1);
      expect(jest.getTimerCount()).toBe(0);
    } finally { jest.useRealTimers(); }
  });
});
