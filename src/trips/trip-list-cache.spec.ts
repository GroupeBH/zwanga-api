import { TripsService } from './trips.service';
import { CacheService } from '../common/services/cache.service';

describe('public trip list cache', () => {
  function fixture(cached: unknown) {
    return Object.assign(Object.create(TripsService.prototype), {
      logger: { debug: jest.fn(), log: jest.fn() }, CACHE_TTL: 300,
      cacheService: { get: jest.fn().mockResolvedValue(cached), set: jest.fn() },
      search: jest.fn().mockResolvedValue([]),
    });
  }

  it('uses a cached empty result without hitting PostgreSQL', async () => {
    const service = fixture([]);
    expect(await service.findAll()).toEqual([]);
    expect(service.cacheService.get).toHaveBeenCalledWith(CacheService.getTripsListKey('discovery-v2'));
    expect(service.search).not.toHaveBeenCalled();
  });

  it('does not revive departed, private, completed or full ongoing trips from cached JSON', async () => {
    const future = { id: 'future', status: 'upcoming', departureDate: '2099-01-01', isPrivate: false, availableSeats: 1 };
    const active = { ...future, id: 'active', status: 'ongoing', departureDate: '2000-01-01' };
    const service = fixture([future, active, { ...future, id: 'expired', departureDate: '2000-01-01' },
      { ...future, isPrivate: true }, { ...future, status: 'completed' }, { ...active, availableSeats: 0 }]);
    expect(await service.findAll()).toEqual([future, active]);
    expect(service.search).not.toHaveBeenCalled();
  });

  it('reuses the default bounded search contract and repopulates the list cache on a miss', async () => {
    const service = fixture(undefined);
    expect(await service.findAll()).toEqual([]);
    expect(service.search).toHaveBeenCalledTimes(1);
    expect(service.search).toHaveBeenCalledWith({});
    expect(service.cacheService.set).toHaveBeenCalledWith(CacheService.getTripsListKey('discovery-v2'), [], 300);
  });
});
