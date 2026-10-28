import { SequentialDispatchService } from './sequential-dispatch.service';

describe('sequential deadline recovery lanes', () => {
  const setup = () => {
    const db = { query: jest.fn().mockResolvedValue([]) };
    const queue = { due: jest.fn().mockResolvedValue([]) };
    const service = new SequentialDispatchService(db as never, { get: () => 'true' } as never,
      queue as never, {} as never, {} as never);
    const advance = jest.spyOn(service, 'advance').mockResolvedValue(true);
    return { db, queue, service, advance };
  };

  it('does not lose Redis deadlines when the SQL recovery scan fails', async () => {
    const { db, queue, service, advance } = setup();
    db.query.mockRejectedValueOnce(new Error('scan timeout'));
    queue.due.mockResolvedValue(['request']);
    await service.deadlines();
    expect(advance).toHaveBeenCalledWith('request');
    expect(service['ticking']).toBe(false);
  });

  it('recovers expired SQL invitations when the Redis read fails', async () => {
    const { db, queue, service, advance } = setup();
    db.query.mockResolvedValue([{ requestId: 'request' }]);
    queue.due.mockRejectedValueOnce(new Error('Redis read timeout'));
    await service.deadlines();
    expect(advance).toHaveBeenCalledWith('request');
    expect(service['ticking']).toBe(false);
  });

  it('processes an invitation once when both sources identify its expiration', async () => {
    const { db, queue, service, advance } = setup();
    db.query.mockResolvedValue([{ requestId: 'request' }]);
    queue.due.mockResolvedValue(['request', 'retry-after-failure']);
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
});
