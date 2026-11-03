import { NotificationService } from './notifications.service';

const deferred = <T = boolean>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};

describe('work-conserving urgent push wakeups (no provider or database)', () => {
  const services: NotificationService[] = [];
  const fixture = (capacity = 2) => {
    const waiting: any[] = [];
    let limit = capacity;
    const builder: any = {};
    for (const name of ['where', 'andWhere', 'orderBy', 'addOrderBy', 'setLock', 'setOnLocked'])
      builder[name] = jest.fn().mockReturnValue(builder);
    builder.take = jest.fn((value: number) => { limit = value; return builder; });
    builder.getMany = jest.fn(async () => waiting.splice(0, limit));
    const repository = { createQueryBuilder: () => builder, save: async (rows: any[]) => rows };
    const transaction = jest.fn(async (work: any) => work({ getRepository: () => repository }));
    const service = new NotificationService(
      { get: (key: string) => key === 'URGENT_PUSH_WORKERS' ? capacity : undefined } as any,
      { manager: { transaction }, update: jest.fn().mockResolvedValue({ affected: 1 }) } as any,
      {} as any, {} as any,
    );
    services.push(service);
    jest.spyOn(service, 'dispatchRealtimeNotifications').mockResolvedValue(undefined);
    const relevant = jest.spyOn(service as any, 'isCriticalNotificationStillDeliverable').mockResolvedValue(true);
    const deliver = jest.spyOn(service as any, 'deliverSavedNotification').mockResolvedValue(true);
    const suppress = jest.spyOn(service as any, 'suppressCriticalNotification').mockResolvedValue(undefined);
    const add = (...ids: string[]) => waiting.push(...ids.map(id => ({
      id, createdAt: new Date(), isActive: true, data: { type: 'driver_dispatch_offer' },
    })));
    return { service, waiting, builder, transaction, relevant, deliver, suppress, add };
  };
  const flush = () => jest.advanceTimersByTimeAsync(1);
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    for (const service of services.splice(0)) service.onModuleDestroy();
    jest.clearAllTimers(); jest.restoreAllMocks(); jest.useRealTimers();
  });

  it('starts a third alert as soon as one slot is free, while the other send still hangs', async () => {
    const f = fixture(); const slow = deferred(), fast = deferred();
    f.add('slow', 'fast', 'next');
    f.deliver.mockImplementation((n: any) => n.id === 'slow' ? slow.promise : n.id === 'fast' ? fast.promise : Promise.resolve(true));
    const first = f.service.dispatchUrgentNotifications();
    await flush(); expect(f.deliver).toHaveBeenCalledTimes(2);
    fast.resolve(true); await flush(); await flush();
    expect(f.deliver).toHaveBeenCalledWith(expect.objectContaining({ id: 'next' }));
    expect((f.service as any).urgentWorkers).toBe(1);
    slow.resolve(true); await first; await flush();
    expect(f.deliver).toHaveBeenCalledTimes(3);
    expect(f.service.dispatchRealtimeNotifications).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('retains a wakeup that arrives while an empty SQL claim is already in progress', async () => {
    const f = fixture(); const emptyClaim = deferred<any[]>();
    f.builder.getMany.mockImplementationOnce(() => emptyClaim.promise);
    const first = f.service.dispatchUrgentNotifications(); await flush();
    f.add('new'); await f.service.dispatchUrgentNotifications();
    emptyClaim.resolve([]); await first; await flush(); await flush();
    expect(f.deliver).toHaveBeenCalledTimes(1);
    expect(f.deliver).toHaveBeenCalledWith(expect.objectContaining({ id: 'new' }));
    expect(jest.getTimerCount()).toBe(0);
  });

  it('starts a synthetic burst of 24 alerts within 500ms despite one 15s send, without a cron tick', async () => {
    const f = fixture(8);
    f.add(...Array.from({ length: 24 }, (_, i) => String(i)));
    const start = Date.now(), started: number[] = [];
    let active = 0, peak = 0;
    f.deliver.mockImplementation(async (n: any) => {
      started.push(Date.now() - start);
      active++; peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, n.id === '0' ? 15_000 : 100));
      active--; return true;
    });
    const first = f.service.dispatchUrgentNotifications();
    await jest.advanceTimersByTimeAsync(500);
    expect(started).toHaveLength(24);
    expect(Math.max(...started)).toBeLessThan(500);
    expect(peak).toBe(8);
    expect(active).toBe(1);
    await jest.advanceTimersByTimeAsync(14_501); await first; await flush();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('coalesces concurrent signals at capacity without exceeding the worker cap', async () => {
    const f = fixture(); const releases = Array.from({ length: 10 }, () => deferred());
    f.add(...releases.map((_, i) => String(i)));
    let active = 0, peak = 0;
    f.deliver.mockImplementation(async (n: any) => {
      active++; peak = Math.max(peak, active);
      await releases[Number(n.id)].promise; active--; return true;
    });
    const first = f.service.dispatchUrgentNotifications(); await flush();
    await Promise.all(Array.from({ length: 100 }, () => f.service.dispatchUrgentNotifications()));
    expect(f.builder.getMany).toHaveBeenCalledTimes(1);
    for (const release of releases) { release.resolve(true); await flush(); await flush(); }
    await first; await flush();
    expect(peak).toBe(2);
    expect(f.deliver).toHaveBeenCalledTimes(10);
    expect(new Set(f.deliver.mock.calls.map(([n]) => (n as any).id)).size).toBe(10);
    expect(f.builder.getMany.mock.calls.length).toBeLessThan(25);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('stops on an empty queue and defers a failed SQL claim to the cron, without spinning', async () => {
    const f = fixture(); f.add('first');
    f.builder.getMany.mockRejectedValueOnce(new Error('synthetic SQL outage'));
    await expect(f.service.dispatchUrgentNotifications()).rejects.toThrow('synthetic SQL outage');
    await jest.advanceTimersByTimeAsync(10_000);
    expect(f.builder.getMany).toHaveBeenCalledTimes(1);
    await f.service.dispatchUrgentNotifications(); await flush();
    expect(f.deliver).toHaveBeenCalledTimes(1);
    const reads = f.builder.getMany.mock.calls.length;
    await jest.advanceTimersByTimeAsync(10_000);
    expect(f.builder.getMany).toHaveBeenCalledTimes(reads);
  });

  it('rechecks relevance for the next job and suppresses a cancelled invitation', async () => {
    const f = fixture(1); f.add('cancelled', 'valid');
    f.relevant.mockResolvedValueOnce(false).mockResolvedValue(true);
    await f.service.dispatchUrgentNotifications(); await flush();
    expect(f.suppress).toHaveBeenCalledTimes(1);
    expect(f.deliver).toHaveBeenCalledTimes(1);
    expect(f.deliver).toHaveBeenCalledWith(expect.objectContaining({ id: 'valid' }));
  });

  it('does not claim new work after shutdown, including a pending release wakeup', async () => {
    const f = fixture(1); const send = deferred(); f.add('active', 'next');
    f.deliver.mockReturnValue(send.promise);
    const first = f.service.dispatchUrgentNotifications(); await flush();
    f.service.onModuleDestroy(); send.resolve(true); await first; await flush();
    await f.service.dispatchUrgentNotifications();
    expect(f.deliver).toHaveBeenCalledTimes(1);
    expect(f.waiting).toHaveLength(1);
    expect(jest.getTimerCount()).toBe(0);
  });
});
