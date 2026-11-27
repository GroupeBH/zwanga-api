import { DriverAvailabilityWakeups } from './driver-availability-wakeups';

describe('bounded committed availability hints', () => {
  const setup = () => {
    const manager = { query: jest.fn(async (sql: string) => sql.startsWith('SET') ? [] : [{ id: 'first' }, { id: 'second' }]) };
    const db = { transaction: jest.fn(async (fn: any) => fn(manager)), query: jest.fn().mockResolvedValue([{ driverId: 'driver' }]) };
    const queue = { claimAvailabilityMany: jest.fn(async (ids: string[]) => [...new Set(ids)].slice(0, 16)), wake: jest.fn().mockResolvedValue(true) };
    const hints = new DriverAvailabilityWakeups(db as any, queue as any);
    const advance = jest.fn().mockResolvedValue(true); hints.bind(advance);
    return { hints, advance, db, manager, queue };
  };
  it('bounds and deduplicates drivers, selects nearby compatible requests and leaves authorisation to the relay', async () => {
    const f = setup();
    expect(await f.hints.driversAvailable(Array.from({ length: 100 }, (_, n) => String(n % 30)), 'old')).toBe(true);
    expect(f.queue.claimAvailabilityMany).toHaveBeenCalledTimes(1);
    const [sql, args] = f.manager.query.mock.calls.find(([sql]) => sql.startsWith('WITH'))! as any;
    expect(sql).toContain('ST_DWithin'); expect(sql).toContain('LIMIT 4');
    expect(sql).toContain('r."vehicleTypes"'); expect(sql).toContain('"targetDriverPriorityUntil"');
    expect(args[1]).toBe('old'); expect(args[2]).toBe(5000); expect(args[3]).toBe(4);
    expect(f.advance.mock.calls).toEqual([['first'], ['second']]);
  });
  it('does not rediscover after another replica consumed the event', async () => {
    const f = setup(); f.queue.claimAvailabilityMany.mockResolvedValue([]);
    expect(await f.hints.driversAvailable(['driver'])).toBe(false);
    expect(f.db.transaction).not.toHaveBeenCalled(); expect(f.advance).not.toHaveBeenCalled();
  });
  it('bounds geographic selection concurrency at two and recovers after a failed hint', async () => {
    const f = setup(); let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    f.db.transaction.mockImplementation(async () => { await blocked; return []; });
    const first = f.hints.driversAvailable(['a']), second = f.hints.driversAvailable(['b']);
    expect(await f.hints.driversAvailable(['c'])).toBe(false);
    release(); await Promise.all([first, second]);
    expect(f.db.transaction).toHaveBeenCalledTimes(2);
    f.queue.claimAvailabilityMany.mockRejectedValue(new Error('offline'));
    await expect(f.hints.driversAvailable(['d'])).resolves.toBe(false);
    await expect(f.hints.driversAvailable(['e'])).resolves.toBe(false);
    expect(f.queue.claimAvailabilityMany).toHaveBeenCalledTimes(3);
  });
  it('bounds relay workers at two and does not start new work after shutdown', async () => {
    const f = setup(); const pending: (() => void)[] = [];
    f.advance.mockImplementation(() => new Promise(resolve => pending.push(() => resolve(true))));
    await f.hints.driversAvailable(['a']); await f.hints.driversAvailable(['b']);
    expect(f.advance).toHaveBeenCalledTimes(2);
    f.hints.onModuleDestroy(); pending.forEach(resolve => resolve());
    await new Promise(resolve => setImmediate(resolve));
    expect(f.advance).toHaveBeenCalledTimes(2);
    expect(await f.hints.driversAvailable(['c'])).toBe(false);
  });
});
