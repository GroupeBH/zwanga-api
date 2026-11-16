import { ZonesWorker } from './zones.worker';

describe('Zones worker isolation and recovery', () => {
  it('does no work when disabled', async () => {
    const em = { query: jest.fn().mockResolvedValue([{ locked: true }]) };
    const db = { transaction: jest.fn((run) => run(em)) };
    const history = { getDriverLocationHistory: jest.fn() };
    await new ZonesWorker(
      db as any,
      { status: async () => ({ enabled: false, ready: true }) } as any,
      history as any,
    ).tick();
    expect(em.query).toHaveBeenCalledTimes(3);
    expect(history.getDriverLocationHistory).not.toHaveBeenCalled();
  });
  it('releases the local latch after a database failure', async () => {
    const db = {
      transaction: jest
        .fn()
        .mockRejectedValueOnce(Error('database unavailable'))
        .mockResolvedValue(undefined),
    };
    const worker = new ZonesWorker(
      db as any,
      { enabled: () => true } as any,
      {} as any,
    );
    await expect(worker.tick()).resolves.toBeUndefined();
    await worker.tick();
    expect(db.transaction).toHaveBeenCalledTimes(2);
  });
  it('does not process rows when another instance owns the advisory lock', async () => {
    const em = { query: jest.fn().mockResolvedValue([{ locked: false }]) };
    const db = {
      transaction: (run: (em: unknown) => Promise<void>) => run(em),
    };
    const history = { getDriverLocationHistory: jest.fn() };
    await new ZonesWorker(
      db as any,
      { enabled: () => true } as any,
      history as any,
    ).tick();
    expect(em.query).toHaveBeenCalledTimes(3);
    expect(history.getDriverLocationHistory).not.toHaveBeenCalled();
  });
  it('bounds a stalled Redis batch without inventing an outside observation', async () => {
    jest.useFakeTimers();
    try {
      const em = { query: jest.fn() };
      const worker = new ZonesWorker(
        {} as any,
        {} as any,
        { getDriverLocationHistory: () => new Promise(() => {}) } as any,
      );
      const pending = (worker as any).monitor(
        em,
        [{ tripId: 'trip', monitor: {} }],
        1,
        0,
      );
      await jest.advanceTimersByTimeAsync(300);
      await pending;
      expect(em.query).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});
