import { LocationHistoryService } from './location-history.service';
import { RedisService } from './redis.service';
import {
  BoardingCandidateSnapshot,
  BoardingDetectionState,
} from '../../bookings/boarding-detection';

describe('LocationHistoryService', () => {
  const createService = () => {
    const store = new Map<string, unknown>();
    const redisService = {
      get: jest.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
      set: jest.fn((key: string, value: unknown) => {
        store.set(key, value);
        return Promise.resolve();
      }),
      compareAndSet: jest.fn(async (key: string, expected: unknown, value: unknown) => {
        if (JSON.stringify(store.get(key) ?? null) !== JSON.stringify(expected)) return false;
        store.set(key, value);
        return true;
      }),
    };
    return {
      service: new LocationHistoryService(
        redisService as unknown as RedisService,
      ),
      store,
      redisService,
    };
  };

  it('keeps the previous moving point when a near-duplicate location is recorded', async () => {
    const { service } = createService();

    await service.recordPassengerLocation(
      'booking-1',
      -4.4,
      15.3,
      new Date('2026-07-27T10:00:00.000Z'),
    );
    await service.recordPassengerLocation(
      'booking-1',
      -4.3995,
      15.3,
      new Date('2026-07-27T10:00:08.000Z'),
    );
    await service.recordPassengerLocation(
      'booking-1',
      -4.399501,
      15.300001,
      new Date('2026-07-27T10:00:09.000Z'),
    );

    const history = await service.getPassengerLocationHistory('booking-1');

    expect(history?.previous?.latitude).toBeCloseTo(-4.4, 6);
    expect(history?.previous?.longitude).toBeCloseTo(15.3, 6);
    expect(history?.current?.latitude).toBeCloseTo(-4.399501, 6);
    expect(history?.current?.longitude).toBeCloseTo(15.300001, 6);
  });

  it('keeps a bounded window with GPS metadata instead of only two points', async () => {
    const { service } = createService();
    const start = new Date('2026-08-06T10:00:00.000Z');

    for (let index = 0; index < 12; index += 1) {
      await service.recordDriverLocation(
        'trip-1',
        -4.3,
        15.3 + index * 0.0001,
        new Date(start.getTime() + index * 3_000),
        {
          accuracyMeters: 8,
          speedMetersPerSecond: 3.5,
          headingDegrees: 90,
        },
      );
    }

    const history = await service.getDriverLocationHistory('trip-1');
    expect(history?.samples).toHaveLength(10);
    expect(history?.samples?.[0].longitude).toBeCloseTo(15.3002, 6);
    expect(history?.current).toEqual(
      expect.objectContaining({
        accuracyMeters: 8,
        speedMetersPerSecond: 3.5,
        headingDegrees: 90,
      }),
    );
  });

  it('does not let a delayed location regress the current Redis sample', async () => {
    const { service } = createService();
    await service.recordPassengerLocation(
      'booking-1',
      -4.3,
      15.31,
      new Date('2026-08-06T10:00:10.000Z'),
      { accuracyMeters: 5 },
    );
    await service.recordPassengerLocation(
      'booking-1',
      -4.3,
      15.3,
      new Date('2026-08-06T10:00:05.000Z'),
      { accuracyMeters: 5 },
    );

    const history = await service.getPassengerLocationHistory('booking-1');
    expect(history?.current?.longitude).toBeCloseTo(15.31, 6);
    expect(history?.samples).toHaveLength(1);
  });

  it('persists candidates under distinct trip/driver/passenger Redis keys', async () => {
    const { service, redisService } = createService();
    const sample = {
      latitude: -4.3,
      longitude: 15.3,
      recordedAt: '2026-08-06T10:00:00.000Z',
      accuracyMeters: 5,
      speedMetersPerSecond: 0,
      headingDegrees: null,
    };
    const candidate: BoardingCandidateSnapshot = {
      state: BoardingDetectionState.BOARDING_CANDIDATE,
      previousState: BoardingDetectionState.DRIVER_APPROACHING,
      createdAt: sample.recordedAt,
      updatedAt: sample.recordedAt,
      initialDriverLocation: sample,
      initialPassengerLocation: sample,
      sharedMovementStartedAt: null,
      separationStartedAt: null,
      confirmedAt: null,
    };

    await service.saveBoardingCandidate(
      'trip-1',
      'driver-1',
      'passenger-1',
      candidate,
    );
    await service.saveBoardingCandidate(
      'trip-1',
      'driver-1',
      'passenger-2',
      candidate,
    );

    expect(redisService.set.mock.calls.map(([key]) => key)).toEqual([
      'trip:trip-1:driver:driver-1:passenger:passenger-1:boarding-candidate',
      'trip:trip-1:driver:driver-1:passenger:passenger-2:boarding-candidate',
    ]);
  });
  it('keeps the newest concurrent update and the bounded history', async () => {
    const { service, redisService } = createService();
    await Promise.all(Array.from({ length: 12 }, (_, i) => service.recordDriverLocation(
      'trip', -4.3, 15.3 + i * 0.001, new Date(Date.UTC(2026, 9, 14, 10, 0, i)),
    )));
    // A final newest observation can always be retried without regressing state.
    await service.recordDriverLocation('trip', -4.3, 15.4, new Date('2026-10-14T10:01:00Z'));
    await service.recordDriverLocation('trip', -4.3, 15.2, new Date('2026-10-14T09:59:00Z'));
    expect((await service.getDriverLocationHistory('trip'))?.current?.longitude).toBe(15.4);
    expect(redisService.compareAndSet).toHaveBeenCalled();
  });

  it('cannot overwrite a newer sample committed after its snapshot was read', async () => {
    const { service, redisService } = createService();
    const compareAndSet = redisService.compareAndSet.getMockImplementation()!;
    let release!: () => void;
    let read!: () => void;
    const paused = new Promise<void>(resolve => { release = resolve; });
    const snapshotRead = new Promise<void>(resolve => { read = resolve; });
    redisService.compareAndSet.mockImplementationOnce(async (...args) => {
      read();
      await paused;
      return compareAndSet(...args);
    });
    const older = service.recordDriverLocation('trip', -4.3, 15.3, new Date('2026-10-14T10:00:00Z'));
    await snapshotRead;
    await service.recordDriverLocation('trip', -4.3, 15.4, new Date('2026-10-14T10:01:00Z'));
    release();
    await older;
    const history = await service.getDriverLocationHistory('trip');
    expect(history?.current?.longitude).toBe(15.4);
    expect(history?.samples).toHaveLength(1);
    expect(redisService.set).not.toHaveBeenCalled();
  });
});
