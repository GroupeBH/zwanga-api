import { LocationHistoryService, LocationHistoryPendingError } from './location-history.service';
import { RedisService } from './redis.service';
import { mergeHistoryReference } from '../../../test/location-history-reference';
import type { LocationHistorySnapshot } from './location-history.service';
import {
  BoardingCandidateSnapshot,
  BoardingDetectionState,
} from '../../bookings/boarding-detection';

describe('LocationHistoryService', () => {
  it('merges a bounded native batch without making old or future fixes fresh', async () => {
    const { service } = createService();
    const now = new Date();
    const samples = Array.from({ length: 10 }, (_, i) => ({ latitude: -4.3,
      longitude: 15.3 + i * 0.0001, accuracy: 5,
      recordedAt: new Date(now.getTime() - (10-i)*8000).toISOString() }));
    await service.recordDriverLocation('batch-trip', -4.3, 15.301, now, { accuracyMeters: 5, samples });
    const history = await service.getDriverLocationHistory('batch-trip');
    expect(history?.samples).toHaveLength(10);
    expect(history?.current?.recordedAt).toBe(now.toISOString());
    await service.recordDriverLocation('batch-trip', -4.3, 15.301, now, { accuracyMeters: 5,
      samples: [ { ...samples[0], recordedAt: new Date(now.getTime()+60000).toISOString() },
        { ...samples[0], recordedAt: new Date(now.getTime()-100000).toISOString() } ] });
    expect((await service.getDriverLocationHistory('batch-trip'))?.samples).toEqual(history?.samples);
  });
  const createService = () => {
    const store = new Map<string, unknown>();
    const client = { eval: jest.fn(), evalSha: jest.fn(async (_sha: string, options: { keys: string[]; arguments: string[] }) => {
      const [key] = options.keys;
      const [current, native, batch] = options.arguments;
      store.set(key, mergeHistoryReference(store.get(key) as LocationHistorySnapshot ?? null,
        JSON.parse(current), JSON.parse(native), batch === '1'));
      return 1;
    }) };
    const redisService = {
      getClient: () => client,
      getMany: jest.fn(async (keys: string[]) => keys.map(key => store.get(key) ?? null)),
      get: jest.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
      set: jest.fn((key: string, value: unknown) => {
        store.set(key, value);
        return Promise.resolve();
      }),
    };
    return {
      service: new LocationHistoryService(
        redisService as unknown as RedisService,
      ),
      store,
      redisService,
      client,
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
    const { service, client } = createService();
    await Promise.all(Array.from({ length: 12 }, (_, i) => service.recordDriverLocation(
      'trip', -4.3, 15.3 + i * 0.001, new Date(Date.UTC(2026, 9, 14, 10, 0, i)),
    )));
    // A final newest observation can always be retried without regressing state.
    await service.recordDriverLocation('trip', -4.3, 15.4, new Date('2026-10-14T10:01:00Z'));
    await service.recordDriverLocation('trip', -4.3, 15.2, new Date('2026-10-14T09:59:00Z'));
    expect((await service.getDriverLocationHistory('trip'))?.current?.longitude).toBe(15.4);
    expect(client.evalSha).toHaveBeenCalledTimes(14);
  });

  it('cannot overwrite a newer sample when an older command arrives late', async () => {
    const { service, redisService, client } = createService();
    const execute = client.evalSha.getMockImplementation()!;
    let release!: () => void;
    let read!: () => void;
    const paused = new Promise<void>(resolve => { release = resolve; });
    const snapshotRead = new Promise<void>(resolve => { read = resolve; });
    client.evalSha.mockImplementationOnce(async (...args) => {
      read();
      await paused;
      return execute(...args);
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

  it('writes once without reading a client-side snapshot or retrying an ambiguous failure', async () => {
    const { service, redisService, client } = createService();
    await service.recordDriverLocation('trip', -4.3, 15.3);
    expect(client.evalSha).toHaveBeenCalledTimes(1);
    expect(redisService.get).not.toHaveBeenCalled();
    client.evalSha.mockRejectedValueOnce(new Error('Redis command deadline'));
    await service.recordDriverLocation('trip', -4.3, 15.4);
    expect(client.evalSha).toHaveBeenCalledTimes(2);
    expect(client.eval).not.toHaveBeenCalled();
  });

  const participant = (at: Date) => [{ bookingId: 'booking', passengerId: 'passenger', driverId: 'driver',
    driverRecordedAt: at, passengerRecordedAt: at }];

  it('reads a bounded snapshot once and reuses it only inside the evaluation', async () => {
    const { service, redisService } = createService();
    const at = new Date();
    await service.recordDriverLocation('trip', -4.3, 15.31, at);
    await service.recordPassengerLocation('booking', -4.3, 15.31, at);
    redisService.get.mockClear();
    await service.withRideSnapshot('trip', participant(at), async () => {
      for (let i = 0; i < 3; i++) {
        expect((await service.getDriverLocationHistory('trip'))?.current?.recordedAt).toBe(at.toISOString());
        expect((await service.getPassengerLocationHistory('booking'))?.current?.recordedAt).toBe(at.toISOString());
      }
      const candidate = { updatedAt: at.toISOString() } as BoardingCandidateSnapshot;
      await service.saveBoardingCandidate('trip', 'driver', 'passenger', candidate);
      expect(await service.getBoardingCandidate('trip', 'driver', 'passenger')).toEqual(candidate);
    });
    expect(redisService.getMany).toHaveBeenCalledTimes(1);
    expect(redisService.getMany.mock.calls[0][0]).toHaveLength(3);
    expect(redisService.get).not.toHaveBeenCalled();
    await service.getDriverLocationHistory('trip');
    expect(redisService.get).toHaveBeenCalledTimes(1);
  });

  it('refuses an old or evicted Redis history before any automatic decision', async () => {
    const { service, store } = createService();
    const at = new Date();
    const work = jest.fn();
    await service.recordDriverLocation('trip', -4.3, 15.31, at);
    await service.recordPassengerLocation('booking', -4.3, 15.31, new Date(at.getTime() - 1));
    await expect(service.withRideSnapshot('trip', participant(at), work)).rejects.toBeInstanceOf(LocationHistoryPendingError);
    await service.recordPassengerLocation('booking', -4.3, 15.31, at);
    store.delete('tracking:history:driver:trip');
    await expect(service.withRideSnapshot('trip', participant(at), work)).rejects.toBeInstanceOf(LocationHistoryPendingError);
    expect(work).not.toHaveBeenCalled();
  });

  it('isolates concurrent evaluation snapshots without caching authorization', async () => {
    const { service } = createService();
    const at = new Date();
    await service.recordDriverLocation('trip', -4.3, 15.31, at);
    await service.recordPassengerLocation('booking', -4.3, 15.31, at);
    let release!: () => void, ready!: () => void;
    const paused = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { ready = resolve; });
    const first = service.withRideSnapshot('trip', participant(at), async () => {
      ready(); await paused;
      expect((await service.getDriverLocationHistory('trip'))?.current?.longitude).toBe(15.31);
    });
    await started;
    await service.recordDriverLocation('trip', -4.3, 15.32, new Date(at.getTime() + 1));
    await service.withRideSnapshot('trip', participant(at), async () => {
      expect((await service.getDriverLocationHistory('trip'))?.current?.longitude).toBe(15.32);
    });
    release(); await first;
  });

  it('propagates a failed multi-read so durable work can retry instead of guessing from missing histories', async () => {
    const { service, redisService } = createService();
    redisService.getMany.mockRejectedValue(new Error('offline'));
    const work = jest.fn();
    await expect(service.withRideSnapshot('trip', participant(new Date()), work)).rejects.toThrow('offline');
    expect(work).not.toHaveBeenCalled();
  });
});
