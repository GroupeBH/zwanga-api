import { SequentialDispatchService } from './sequential-dispatch.service';

describe('sequential deadline recovery lanes', () => {
  const setup = () => {
    const db = { query: jest.fn(async (_sql: string, args?: string[][]) => args ? args[0].map(id => ({ id })) : []) };
    const queue = { claimDue: jest.fn().mockResolvedValue([]) };
    const service = new SequentialDispatchService(db as never, { get: () => 'true' } as never,
      queue as never, {} as never, {} as never);
    const advance = jest.spyOn(service, 'advance').mockResolvedValue(true);
    return { db, queue, service, advance };
  };

  it('does not lose Redis deadlines when the SQL recovery scan fails', async () => {
    const { db, queue, service, advance } = setup();
    db.query.mockRejectedValueOnce(new Error('scan timeout'));
    queue.claimDue.mockResolvedValue(['request']);
    await service.deadlines();
    expect(advance).toHaveBeenCalledWith('request');
    expect(service['ticking']).toBe(false);
  });

  it('recovers expired SQL invitations when the Redis read fails', async () => {
    const { db, queue, service, advance } = setup();
    db.query.mockResolvedValueOnce([{ requestId: 'request' }] as any);
    queue.claimDue.mockRejectedValueOnce(new Error('Redis read timeout'));
    await service.deadlines();
    expect(advance).toHaveBeenCalledWith('request');
    expect(service['ticking']).toBe(false);
  });

  it('processes an invitation once when both sources identify its expiration', async () => {
    const { db, queue, service, advance } = setup();
    db.query.mockResolvedValueOnce([{ requestId: 'request' }] as any);
    queue.claimDue.mockResolvedValue(['request', 'retry-after-failure']);
    await service.deadlines();
    expect(advance.mock.calls).toEqual([['request'], ['retry-after-failure']]);
  });

  it('schedules a Redis retry after an SQL failure instead of relying on the next discovery scan', async () => {
    const db = { transaction: jest.fn().mockRejectedValueOnce(new Error('temporary SQL failure')) };
    const queue = { schedule: jest.fn().mockResolvedValue(undefined) };
    const service = new SequentialDispatchService(db as never, { get: () => 'true' } as never,
      queue as never, {} as never, {} as never);
    const before = Date.now();
    expect(await service.advance('request')).toBe(false);
    expect(queue.schedule).toHaveBeenCalledTimes(1);
    expect(queue.schedule.mock.calls[0][0]).toBe('request');
    expect(queue.schedule.mock.calls[0][1]).toBeGreaterThanOrEqual(before + 1000);
    expect(queue.schedule.mock.calls[0][1]).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('still cleans up deleted requests which are absent from the SQL priority read', async () => {
    const { db, queue, service, advance } = setup();
    queue.claimDue.mockResolvedValue(['deleted', 'live']);
    db.query.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 'live' }]);
    await service.deadlines();
    expect(advance.mock.calls).toEqual([['live'], ['deleted']]);
  });

  it('shares a three-relay budget across callers and coalesces duplicate requests before SQL', async () => {
    let finish!: () => void;
    const blocked = new Promise<void>(resolve => { finish = resolve; });
    const db = { transaction: jest.fn(async () => { await blocked; return null; }) };
    const queue = { schedule: jest.fn().mockResolvedValue(undefined), close: jest.fn().mockResolvedValue(undefined) };
    const changes = { enqueue: jest.fn() };
    const service = new SequentialDispatchService(db as never, { get: () => 'true' } as never,
      queue as never, {} as never, changes as never);
    const jobs = ['a', 'b', 'c'].map(id => service.advance(id));
    expect(await service.advance('a')).toBe(false);
    expect(await service.advance('d')).toBe(false);
    expect(db.transaction).toHaveBeenCalledTimes(3);
    expect(queue.schedule).toHaveBeenCalledWith('d', expect.any(Number));
    finish(); await Promise.all(jobs);
    // No cron/one-second sleep: the freed slot immediately consumes the hint.
    await service['ready'].stop();
    expect(service['activeRequests'].size).toBe(0);
    expect(db.transaction).toHaveBeenCalledTimes(4);
    expect(service.diagnosticSnapshot().reasons.local_capacity).toBe(1);
    await service.onModuleDestroy();
  });

  it('refills small deadline batches before the next cron and stops when Redis is empty', async () => {
    jest.useFakeTimers();
    const { queue, service, advance } = setup();
    queue.claimDue.mockResolvedValueOnce(['a', 'b', 'c', 'd', 'e', 'f']).mockResolvedValueOnce(['g']);
    try {
      await service.deadlines();
      expect(advance).toHaveBeenCalledTimes(6);
      expect(queue.claimDue).toHaveBeenCalledWith(expect.any(Number), 6);
      await jest.advanceTimersByTimeAsync(25);
      expect(advance).toHaveBeenCalledWith('g');
      await jest.advanceTimersByTimeAsync(900);
      expect(queue.claimDue).toHaveBeenCalledTimes(2);
    } finally { await service.onModuleDestroy(); jest.useRealTimers(); }
  });

  it('drains active SQL work on shutdown without starting deferred hints', async () => {
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const db = { transaction: jest.fn(async () => { await pending; return null; }) };
    const queue = { schedule: jest.fn().mockResolvedValue(undefined), close: jest.fn().mockResolvedValue(undefined) };
    const service = new SequentialDispatchService(db as never, { get: () => 'true' } as never,
      queue as never, {} as never, { enqueue: jest.fn() } as never);
    const jobs = ['a', 'b', 'c'].map(id => service.advance(id));
    await service.advance('d');
    let stopped = false;
    const stop = service.onModuleDestroy().then(() => { stopped = true; });
    await Promise.resolve(); expect(stopped).toBe(false);
    release(); await Promise.all([...jobs, stop]);
    expect(db.transaction).toHaveBeenCalledTimes(3);
    expect(queue.schedule).toHaveBeenCalledWith('d', expect.any(Number));
    expect(await service.advance('e')).toBe(false);
  });
});
