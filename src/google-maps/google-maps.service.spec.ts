import { of, Subject, NEVER } from 'rxjs';
import { GoogleMapsService } from './google-maps.service';

describe('GoogleMapsService directions', () => {
  it('coalesces provider requests and aborts timed-out work without caching it', async () => {
    jest.useFakeTimers();
    try {
      const response = new Subject<any>();
      const get = jest.fn().mockReturnValue(response);
      const cache = { get: jest.fn().mockResolvedValue(undefined), set: jest.fn().mockResolvedValue(undefined) };
      const service = new GoogleMapsService({ get } as any, { get: () => 'synthetic' } as any, cache as any);
      const dto = { origin: { lat: -4.3, lng: 15.3 }, destination: { lat: -4.31, lng: 15.31 } };
      const one = service.getDirections(dto, { timeoutMs: 1000 });
      const two = service.getDirections(dto, { timeoutMs: 1000 });
      await jest.advanceTimersByTimeAsync(0);
      expect(get).toHaveBeenCalledTimes(1);
      response.next({ data: { status: 'OK', routes: [buildProviderRoute('Shared')] } }); response.complete();
      expect(await one).toEqual(await two);
      get.mockReturnValue(NEVER); cache.set.mockClear();
      const timeout = service.getDirections(dto, { timeoutMs: 1000 });
      const rejected = expect(timeout).rejects.toThrow('PROVIDER_BUDGET_EXHAUSTED');
      await jest.advanceTimersByTimeAsync(1000); await rejected;
      expect(get.mock.calls[1][1].signal.aborted).toBe(true);
      expect(cache.set).not.toHaveBeenCalled();
      get.mockReturnValue(of({ data: { status: 'OK', routes: [buildProviderRoute('Recovered')] } }));
      await expect(service.getDirections(dto)).resolves.toHaveProperty('routes');
    } finally { jest.useRealTimers(); }
  });
  const buildProviderRoute = (summary: string) => ({
    summary,
    legs: [
      {
        distance: { value: 1200 },
        duration: { value: 600 },
        start_address: 'Start',
        end_address: 'End',
        start_location: { lat: -4.3, lng: 15.3 },
        end_location: { lat: -4.31, lng: 15.31 },
        steps: [
          {
            distance: { value: 1200 },
            duration: { value: 600 },
            html_instructions: 'Continue',
            polyline: { points: 'abc' },
            start_location: { lat: -4.3, lng: 15.3 },
            end_location: { lat: -4.31, lng: 15.31 },
          },
        ],
      },
    ],
    overview_polyline: { points: 'overview' },
    bounds: {
      northeast: { lat: -4.3, lng: 15.31 },
      southwest: { lat: -4.31, lng: 15.3 },
    },
    copyrights: 'Map data',
    warnings: [],
  });

  it.each([900, undefined, NaN, -20])('preserves only valid traffic durations (%s) and caches them for one minute', async trafficSeconds => {
    const route = buildProviderRoute('Traffic route');
    Object.assign(route.legs[0], { duration_in_traffic: { value: trafficSeconds } });
    const get = jest.fn().mockReturnValue(of({ data: { status: 'OK', routes: [route] } }));
    const cache = { get: jest.fn().mockResolvedValue(undefined), set: jest.fn().mockResolvedValue(undefined) };
    const service = new GoogleMapsService({ get } as any, { get: () => 'test-key' } as any, cache as any);
    const dto = { origin: { lat: -4.3, lng: 15.3 }, destination: { lat: -4.31, lng: 15.31 }, departureTime: 1893456010 };
    const result = await service.getDirections(dto);
    expect(result.routes[0].legs[0].durationInTraffic).toBe(trafficSeconds === 900 ? 900 : undefined);
    expect(get).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ params: expect.objectContaining({ departure_time: '1893456010' }) }));
    expect(cache.set).toHaveBeenCalledWith(expect.stringContaining('traffic-v1:'), result, 60);
    const key = (service as any).getDirectionsCacheKey(dto);
    expect((service as any).getDirectionsCacheKey({ ...dto, departureTime: dto.departureTime + 10 })).toBe(key);
    expect((service as any).getDirectionsCacheKey({ ...dto, departureTime: dto.departureTime + 60 })).not.toBe(key);
    expect((service as any).getDirectionsCacheKey({ ...dto, departureTime: undefined })).not.toBe(key);
  });

  it.each([[5000, 5000], [1, 1000], [60000, 30000]])('bounds the optional approach HTTP timeout %s', async (timeoutMs, expected) => {
    const get = jest.fn().mockReturnValue(of({ data: { status: 'OK', routes: [buildProviderRoute('Pickup')] } }));
    const cache = { get: jest.fn().mockResolvedValue(undefined), set: jest.fn().mockResolvedValue(undefined) };
    const service = new GoogleMapsService({ get } as any, { get: () => 'test-key' } as any, cache as any);
    await service.getDirections({ origin: { lat: -4.3, lng: 15.3 }, destination: { lat: -4.31, lng: 15.31 } }, { timeoutMs });
    expect(get).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ timeout: expected }));
  });

  it('requests and returns only one route even when alternatives are requested', async () => {
    const httpService = {
      get: jest.fn().mockReturnValue(
        of({
          data: {
            status: 'OK',
            routes: [
              buildProviderRoute('Primary route'),
              buildProviderRoute('Alternative route'),
            ],
          },
        }),
      ),
    };
    const configService = {
      get: jest.fn((key: string) =>
        key === 'GOOGLE_MAPS_API_KEY' ? 'test-key' : undefined,
      ),
    };
    const cacheService = {
      get: jest.fn().mockResolvedValue(undefined),
      set: jest.fn().mockResolvedValue(undefined),
    };
    const service = new GoogleMapsService(
      httpService as any,
      configService as any,
      cacheService as any,
    );

    const result = await service.getDirections({
      origin: { lat: -4.3, lng: 15.3 },
      destination: { lat: -4.31, lng: 15.31 },
      alternatives: true,
    });

    expect(httpService.get).toHaveBeenCalledWith(
      'https://maps.googleapis.com/maps/api/directions/json',
      expect.objectContaining({
        params: expect.objectContaining({
          alternatives: 'false',
        }),
      }),
    );
    expect(result.routes).toHaveLength(1);
    expect(result.routes[0].summary).toBe('Primary route');
    expect(cacheService.set).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        routes: [expect.objectContaining({ summary: 'Primary route' })],
      }),
      604800,
    );
  });
});
