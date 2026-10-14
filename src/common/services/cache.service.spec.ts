import { CacheService } from './cache.service';

describe('optional read cache failure isolation', () => {
  const fixture = () => {
    const cache = {
      get: jest.fn(),
      set: jest.fn(),
      del: jest.fn(),
      reset: jest.fn(),
    };
    return { cache, service: new CacheService(cache as any) };
  };
  it('falls back on read errors and does not fail committed writes on set/delete errors', async () => {
    const { cache, service } = fixture();
    for (const operation of [cache.get, cache.set, cache.del])
      operation.mockRejectedValue(new Error('offline'));
    await expect(service.get('trip:1')).resolves.toBeUndefined();
    await expect(service.set('trip:1', { id: 1 })).resolves.toBeUndefined();
    await expect(service.del('trip:1')).resolves.toBeUndefined();
    expect(cache.reset).not.toHaveBeenCalled();
  });
  it('retries a failed invalidation before serving the old cached projection', async () => {
    const { cache, service } = fixture();
    cache.get.mockResolvedValue('stale');
    cache.del.mockRejectedValue(new Error('offline'));
    await service.del('trip:1');
    expect(await service.get('trip:1')).toBeUndefined();
    expect(cache.get).not.toHaveBeenCalled();
    cache.del.mockResolvedValue(undefined);
    cache.get.mockResolvedValue(undefined);
    await service.get('trip:1');
    expect(cache.get).toHaveBeenCalledTimes(1);
  });
  it('still invalidates dependent caches when the first deletion fails', async () => {
    const { cache, service } = fixture();
    cache.del.mockRejectedValue(new Error('offline'));
    await service.del('bookings:passenger:test');
    expect(cache.del.mock.calls).toEqual([
      ['bookings:passenger:test'],
      ['bookings:passenger:test:activity'],
    ]);
    await service.del(CacheService.getTripsListKey());
    expect(cache.del).toHaveBeenCalledWith('trips:list:discovery-v2');
  });
  it('bounds a hung command, without touching authentication Redis', async () => {
    jest.useFakeTimers();
    try {
      const { cache, service } = fixture();
      cache.get.mockReturnValue(new Promise(() => {}));
      const result = service.get('trip:1');
      await jest.advanceTimersByTimeAsync(601);
      expect(await result).toBeUndefined();
      expect(cache.reset).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not clear a newer failed invalidation when an older deletion completes', async () => {
    const { cache, service } = fixture();
    let release!: () => void;
    cache.del.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const first = service.del('trip:1');
    cache.del.mockRejectedValue(new Error('offline'));
    await service.del('trip:1');
    release();
    await first;
    expect(await service.get('trip:1')).toBeUndefined();
    expect(cache.get).not.toHaveBeenCalled();
  });

  it('bounds failed invalidation tracking without flushing shared Redis', async () => {
    const { cache, service } = fixture();
    cache.del.mockRejectedValue(new Error('offline'));
    for (let index = 0; index <= 1000; index++)
      await service.del(`trip:${index}`);
    await service.set('new', 'value');
    expect(await service.get('new')).toBeUndefined();
    expect(cache.get).not.toHaveBeenCalled();
    expect(cache.set).not.toHaveBeenCalled();
    expect(cache.del).toHaveBeenCalledTimes(1000);
    expect(cache.reset).not.toHaveBeenCalled();
  });
});
