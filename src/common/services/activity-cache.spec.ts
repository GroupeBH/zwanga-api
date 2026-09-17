import { CacheService } from './cache.service';

describe('passenger activity cache isolation', () => {
  const fixture = () => {
    const values = new Map<string, unknown>();
    const manager = { get: jest.fn(async (key: string) => values.get(key)),
      set: jest.fn(async (key: string, value: unknown) => { values.set(key, value); }),
      del: jest.fn(async (key: string) => { values.delete(key); }) };
    return { service: new CacheService(manager as any), manager, values };
  };

  it('keeps history and activity separate, then invalidates both with existing mutation calls', async () => {
    const { service, values } = fixture();
    const history = CacheService.getBookingsByPassengerKey('passenger');
    const activity = CacheService.getBookingsByPassengerActivityKey('passenger');
    await service.set(history, ['old', 'active'], 180);
    await service.set(activity, ['active'], 180);
    await service.set(CacheService.getBookingsByPassengerActivityKey('other'), ['other'], 180);
    expect(await service.get(history)).toEqual(['old', 'active']);
    expect(await service.get(activity)).toEqual(['active']);
    await service.del(history);
    expect(values.has(history)).toBe(false); expect(values.has(activity)).toBe(false);
    expect(values.has(CacheService.getBookingsByPassengerActivityKey('other'))).toBe(true);
  });

  it('does not cascade unrelated keys or recursively append the activity suffix', async () => {
    const { service, manager } = fixture();
    await service.del('trip:one');
    await service.del('bookings:passenger:one:activity');
    expect(manager.del.mock.calls).toEqual([['trip:one'], ['bookings:passenger:one:activity']]);
  });
});
