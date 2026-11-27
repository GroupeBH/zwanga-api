import { createClient } from 'redis';
import { randomUUID } from 'node:crypto';
import { appendLocationHistory } from './location-history-store';
import { LocationHistoryService, LocationHistoryPendingError, LocationHistorySnapshot, TrackedLocationPoint } from './location-history.service';
import { RedisService } from './redis.service';
import { mergeHistoryReference } from '../../../test/location-history-reference';

// Only the dedicated runner supplies these, never REDIS_URL or .env.
const enabled = Boolean(process.env.HISTORY_TEST_REDIS_PORT && process.env.HISTORY_TEST_REDIS_PASSWORD);
(enabled ? describe : describe.skip)('atomic history on disposable Redis', () => {
  const client = createClient({ socket: { host: '127.0.0.1', port: Number(process.env.HISTORY_TEST_REDIS_PORT),
    reconnectStrategy: false, connectTimeout: 1000 }, password: process.env.HISTORY_TEST_REDIS_PASSWORD });
  const second = client.duplicate();
  const redis = Object.assign(Object.create(RedisService.prototype), { client }) as RedisService;
  const service = new LocationHistoryService(redis);
  let key: string;
  const point = (at: string, longitude = 15.3): TrackedLocationPoint => ({ latitude: -4.3, longitude,
    recordedAt: at, accuracyMeters: 5, speedMetersPerSecond: 2, headingDegrees: 90 });
  const read = async () => JSON.parse((await client.get(key))!) as LocationHistorySnapshot;
  const append = (current: TrackedLocationPoint, native: TrackedLocationPoint[] = [], batch = false) =>
    appendLocationHistory(client, key, current, native, batch, 21600);
  beforeAll(async () => {
    client.on('error', () => {}); second.on('error', () => {});
    await client.connect(); await second.connect();
  });
  beforeEach(() => { key = `history-test:${randomUUID()}`; });
  afterAll(async () => {
    if (second.isOpen) await second.quit();
    if (client.isOpen) await client.quit();
  });

  it('uses a single cached command after warmup, without a history GET or CAS loop', async () => {
    await append(point('2026-11-22T19:00:00.000Z'));
    const sha = jest.spyOn(client, 'evalSha'), evalScript = jest.spyOn(client, 'eval'), get = jest.spyOn(client, 'get');
    try {
      for (let i = 1; i <= 10; i++) await append(point(`2026-11-22T19:00:${String(i).padStart(2, '0')}.000Z`, 15.3 + i / 1000));
      expect(sha).toHaveBeenCalledTimes(10);
      expect(evalScript).not.toHaveBeenCalled(); expect(get).not.toHaveBeenCalled();
    } finally { jest.restoreAllMocks(); }
    expect((await read()).samples).toHaveLength(10);
    expect(await client.ttl(key)).toBeGreaterThanOrEqual(21590);
  });

  it.each(['2026-12-31T23:59:59.500Z', '2028-02-28T23:59:59.500Z', '2028-02-29T23:59:59.500Z'])(
    'preserves the previous moving point across calendar boundaries: %s', async date => {
      const at = Date.parse(date);
      await append(point(new Date(at - 8000).toISOString(), 15.299));
      await append(point(date));
      await append(point(new Date(at + 1000).toISOString(), 15.300001));
      expect((await read()).samples).toHaveLength(2);
      expect((await read()).previous?.longitude).toBe(15.299);
      await append(point(new Date(at + 22000).toISOString(), 15.300001));
      expect((await read()).samples).toHaveLength(3);
    });

  it('matches the old merge semantics across movement, duplicate, batch and stale fixes', async () => {
    let expected: LocationHistorySnapshot | null = null;
    const start = Date.parse('2026-11-22T19:00:00.000Z');
    for (let i = 0; i < 80; i++) {
      const current = point(new Date(start + (i % 11 === 10 ? i - 4 : i) * 3000).toISOString(),
        15.3 + Math.floor(i / 3) * 0.0001);
      const native = i % 4 === 0 ? [point(new Date(start + i * 3000 - 1000).toISOString(), 15.30001)] : [];
      expected = mergeHistoryReference(expected, current, native, native.length > 0);
      await append(current, native, native.length > 0);
      // Lua JSON numbers keep 14 significant digits; compare geometry at a
      // much finer precision than the 3 m duplicate threshold.
      const actual = await read();
      expect(actual.samples?.map(p => p.recordedAt)).toEqual(expected.samples?.map(p => p.recordedAt));
      expect(actual.previous?.recordedAt).toBe(expected.previous?.recordedAt);
      expect(actual.current?.recordedAt).toBe(expected.current?.recordedAt);
      actual.samples!.forEach((p, n) => {
        expect(p.longitude).toBeCloseTo(expected!.samples![n].longitude, 10);
        expect(p.accuracyMeters).toBe(expected!.samples![n].accuracyMeters);
      });
    }
  });

  it('keeps the newest position from two API connections and never drops it after three CAS conflicts', async () => {
    const start = Date.parse('2026-11-22T19:00:00.000Z');
    const points = Array.from({ length: 100 }, (_, i) => point(new Date(start + i * 1000).toISOString(), 15.3 + i * 0.0001));
    await Promise.all(points.map((p, i) => appendLocationHistory(i % 2 ? second : client, key, p, [], false, 21600)));
    expect((await read()).current?.recordedAt).toBe(points.at(-1)!.recordedAt);
    expect((await read()).samples!.length).toBeLessThanOrEqual(10);
    // Old fixes do not extend the history TTL or regress the accepted position.
    await client.pExpire(key, 60000);
    await append(points[0]);
    expect(await client.pTTL(key)).toBeLessThanOrEqual(60000);
    expect((await read()).current?.recordedAt).toBe(points.at(-1)!.recordedAt);
  });

  it('upgrades a legacy two-point snapshot and keeps accepted points over conflicting native samples', async () => {
    const a = point('2026-11-22T19:00:00.000Z'), b = point('2026-11-22T19:00:05.000Z', 15.31);
    await client.set(key, JSON.stringify({ previous: a, current: b }));
    const c = point('2026-11-22T19:00:10.000Z', 15.32);
    await append(c, [{ ...b, longitude: 16 }, { ...c, longitude: 17 }], true);
    expect((await read()).samples).toEqual([a, b, c]);
  });

  it('reloads after losing the script cache without losing the history', async () => {
    await append(point('2026-11-22T19:00:00.000Z'));
    // This server was created by the dedicated test runner and has no app data.
    await client.scriptFlush();
    await append(point('2026-11-22T19:00:05.000Z', 15.31));
    expect((await read()).samples).toHaveLength(2);
  });

  it('does not overwrite corrupt history with fabricated progress', async () => {
    await client.set(key, 'corrupt');
    await expect(append(point('2026-11-22T19:00:00.000Z'))).rejects.toThrow();
    expect(await client.get(key)).toBe('corrupt');
  });

  it('filters inaccurate, future and stale native points before the Redis command', async () => {
    const trip = randomUUID(), now = new Date();
    const sample = { latitude: -4.3, longitude: 15.31, accuracy: 5, recordedAt: new Date(+now - 5000).toISOString() };
    await service.recordDriverLocation(trip, -4.3, 15.32, now, { samples: [sample,
      { ...sample, recordedAt: new Date(+now + 1000).toISOString() },
      { ...sample, recordedAt: new Date(+now - 91000).toISOString() },
      { ...sample, recordedAt: new Date(+now - 2000).toISOString(), accuracy: 71 }] });
    const snapshot = await service.getDriverLocationHistory(trip);
    expect(snapshot?.samples?.map(p => p.recordedAt)).toEqual([sample.recordedAt, now.toISOString()]);
  });

  it('postpones automatic decisions for missing or lagging Redis history until it catches up with SQL', async () => {
    const trip = randomUUID(), booking = randomUUID(), now = new Date();
    const participants = [{ bookingId: booking, passengerId: 'p', driverId: 'd', driverRecordedAt: now, passengerRecordedAt: now }];
    const work = jest.fn().mockResolvedValue('ready');
    await expect(service.withRideSnapshot(trip, participants, work)).rejects.toBeInstanceOf(LocationHistoryPendingError);
    await service.recordDriverLocation(trip, -4.3, 15.3, now);
    await service.recordPassengerLocation(booking, -4.3, 15.3, new Date(+now - 1));
    await expect(service.withRideSnapshot(trip, participants, work)).rejects.toBeInstanceOf(LocationHistoryPendingError);
    expect(work).not.toHaveBeenCalled();
    await service.recordPassengerLocation(booking, -4.3, 15.3, now);
    expect(await service.withRideSnapshot(trip, participants, work)).toBe('ready');
  });
});
