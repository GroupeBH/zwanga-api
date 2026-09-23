import { BookingsService } from '../bookings/bookings.service';

describe('activity booking list freshness', () => {
  const fixture = () => {
    const fresh = [{ id: 'current', status: 'completed' }];
    const stale = [{ id: 'current', status: 'accepted' }];
    const cache = { get: jest.fn(async () => stale), set: jest.fn(async () => undefined) };
    const repository = { find: jest.fn(async () => fresh) };
    const attach = jest.fn(async () => undefined);
    const service: BookingsService = Object.assign(Object.create(BookingsService.prototype), {
      cacheService: cache, bookingRepository: repository, CACHE_TTL: 180,
      logger: { debug: jest.fn() }, attachActiveInterruptionRequestsToBookings: attach,
    });
    return { service, cache, repository, attach, fresh, stale };
  };

  it('never acknowledges a fresh activity revision with the stale Redis booking list', async () => {
    const { service, cache, repository, attach, fresh } = fixture();
    expect(await service.findAllByPassenger('account-a', true)).toEqual(fresh);
    expect(cache.get).not.toHaveBeenCalled();
    expect(cache.set).not.toHaveBeenCalled();
    expect(repository.find).toHaveBeenCalledTimes(1);
    const { where } = repository.find.mock.calls[0][0];
    expect(where.length).toBeGreaterThan(0);
    expect(where.every((clause: { passengerId: string }) => clause.passengerId === 'account-a')).toBe(true);
    expect(attach).toHaveBeenCalledWith(fresh);
  });

  it('retains the cache for ordinary lists, including populating it on a miss', async () => {
    const { service, cache, repository, fresh, stale } = fixture();
    expect(await service.findAllByPassenger('account-a')).toEqual(stale);
    expect(repository.find).not.toHaveBeenCalled();
    cache.get.mockResolvedValueOnce(undefined);
    expect(await service.findAllByPassenger('account-a')).toEqual(fresh);
    expect(repository.find).toHaveBeenCalledWith(expect.objectContaining({ where: { passengerId: 'account-a' } }));
    expect(cache.set).toHaveBeenCalledWith('bookings:passenger:account-a', fresh, 180);
  });
});
