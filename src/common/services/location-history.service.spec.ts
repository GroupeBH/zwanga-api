import { LocationHistoryService } from './location-history.service';

describe('LocationHistoryService', () => {
  it('keeps the previous moving point when a near-duplicate location is recorded', async () => {
    const store = new Map<string, unknown>();
    const redisService = {
      get: jest.fn(async (key: string) => store.get(key) ?? null),
      set: jest.fn(async (key: string, value: unknown) => {
        store.set(key, value);
      }),
    };
    const service = new LocationHistoryService(redisService as any);

    await service.recordPassengerLocation(
      'booking-1',
      -4.400000,
      15.300000,
      new Date('2026-07-27T10:00:00.000Z'),
    );
    await service.recordPassengerLocation(
      'booking-1',
      -4.399500,
      15.300000,
      new Date('2026-07-27T10:00:08.000Z'),
    );
    await service.recordPassengerLocation(
      'booking-1',
      -4.399501,
      15.300001,
      new Date('2026-07-27T10:00:09.000Z'),
    );

    const history = await service.getPassengerLocationHistory('booking-1');

    expect(history?.previous?.latitude).toBeCloseTo(-4.400000, 6);
    expect(history?.previous?.longitude).toBeCloseTo(15.300000, 6);
    expect(history?.current?.latitude).toBeCloseTo(-4.399501, 6);
    expect(history?.current?.longitude).toBeCloseTo(15.300001, 6);
  });
});
