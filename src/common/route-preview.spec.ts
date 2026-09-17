import { attachBookingRoutePreviews, getTripRoutePreview, rememberRoutePreview, routePreviewKey } from './route-preview';

const dto = { origin: { lat: -4.3, lng: 15.3 }, destination: { lat: -4.4, lng: 15.4 } };
const trip = { id: 't', status: 'upcoming', departureDate: new Date('2026-09-17T10:00:00Z'),
  departurePoint: { coordinates: [15.3, -4.3] }, arrivalPoint: { coordinates: [15.4, -4.4] } } as any;
const fixture = () => ({ get: jest.fn().mockResolvedValue(undefined), set: jest.fn().mockResolvedValue(undefined) }) as any;

describe('server list route previews without provider calls', () => {
  it('reuses an already calculated driving route, sums legs and supplies a dated preview', async () => {
    const cache = fixture();
    await rememberRoutePreview(cache, dto, { routes: [{ legs: [{ duration: 300 }, { duration: 600 }] }] } as any);
    expect(cache.set.mock.calls[0][0]).toBe(routePreviewKey(dto.origin, dto.destination));
    expect(cache.set.mock.calls[0][2]).toBe(86_400_000); // cache-manager v5 TTL in milliseconds
    cache.get.mockResolvedValue(cache.set.mock.calls[0][1]);
    expect(await getTripRoutePreview(cache, trip)).toEqual({ estimatedDurationSeconds: 900,
      arrivalEstimateSource: 'route', previewArrivalDate: '2026-09-17T10:15:00.000Z' });
  });

  it('keys include direction and coordinates; walking, avoided roads and waypoints cannot contaminate driving previews', async () => {
    const cache = fixture(), response = { routes: [{ legs: [{ duration: 600 }] }] } as any;
    for (const variant of [{ mode: 'walking' }, { waypoints: [dto.origin] }, { avoid: ['tolls'] }]) {
      await rememberRoutePreview(cache, { ...dto, ...variant } as any, response);
    }
    expect(cache.set).not.toHaveBeenCalled();
    expect(routePreviewKey(dto.origin, dto.destination)).not.toBe(routePreviewKey(dto.destination, dto.origin));
    expect(routePreviewKey({ lat: 91, lng: 15 }, dto.destination)).toBeNull();
    cache.set.mockRejectedValueOnce(new Error('cache offline'));
    await expect(rememberRoutePreview(cache, dto, response)).resolves.toBeUndefined();
  });

  it('cache miss/stale/invalid/failure yields an explicit approximation, without touching persisted price or deadline', async () => {
    const cache = fixture(), original = JSON.stringify(trip);
    for (const summary of [undefined, { seconds: 900, savedAt: Date.now() - 86_400_001 }, { seconds: NaN, savedAt: Date.now() }]) {
      cache.get.mockResolvedValueOnce(summary);
      const preview = await getTripRoutePreview(cache, trip);
      expect(preview.arrivalEstimateSource).toBe('approximate'); expect(preview.estimatedDurationSeconds).toBeGreaterThan(0);
    }
    cache.get.mockRejectedValueOnce(new Error('cache unavailable'));
    expect((await getTripRoutePreview(cache, trip)).arrivalEstimateSource).toBe('approximate');
    expect(JSON.stringify(trip)).toBe(original);
    expect(await getTripRoutePreview(cache, { ...trip, arrivalPoint: null })).toEqual({
      estimatedDurationSeconds: null, arrivalEstimateSource: 'unavailable', previewArrivalDate: null });
  });

  it('completed trips retain their actual start-based duration; changing scheduled routes does not reuse old deadlines', async () => {
    const cache = fixture(), started = { ...trip, status: 'completed', startedAt: new Date('2026-09-17T10:10:00Z'),
      estimatedArrivalDate: new Date('2026-09-17T10:25:00Z') };
    expect(await getTripRoutePreview(cache, started)).toEqual({ estimatedDurationSeconds: 900,
      arrivalEstimateSource: 'trip_start', previewArrivalDate: '2026-09-17T10:25:00.000Z' });
    expect(cache.get).not.toHaveBeenCalled();
    expect((await getTripRoutePreview(cache, { ...started, status: 'upcoming' })).arrivalEstimateSource).toBe('approximate');
  });

  it('multiple bookings for the same trip share one cached summary lookup', async () => {
    const cache = fixture(), bookings = [{ trip: { ...trip } }, { trip: { ...trip } }, {}];
    await attachBookingRoutePreviews(cache, bookings);
    expect(cache.get).toHaveBeenCalledTimes(1);
    expect((bookings[0].trip as any).arrivalEstimateSource).toBe('approximate');
    expect((bookings[1].trip as any).estimatedDurationSeconds).toBeGreaterThan(0);
  });
});
