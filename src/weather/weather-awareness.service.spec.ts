import { of, throwError } from 'rxjs';
import { WeatherAwarenessService } from './weather-awareness.service';
import { WeatherObservation } from './weather.types';

describe('WeatherAwarenessService', () => {
  let cache: Map<string, WeatherObservation>;
  let cacheService: { get: jest.Mock; set: jest.Mock };
  let configService: { get: jest.Mock };

  beforeEach(() => {
    cache = new Map<string, WeatherObservation>();
    cacheService = {
      get: jest.fn((key: string) => Promise.resolve(cache.get(key))),
      set: jest.fn((key: string, value: WeatherObservation) => {
        cache.set(key, value);
        return Promise.resolve();
      }),
    };
    configService = {
      get: jest.fn((key: string) => {
        if (key === 'OPENWEATHER_API_KEY') {
          return 'weather-api-key';
        }
        return undefined;
      }),
    };
  });

  it('refreshes the four Kinshasa zones and detects heavy rain', async () => {
    const httpService = {
      get: jest.fn(() =>
        of({
          data: {
            weather: [{ id: 502, description: 'heavy intensity rain' }],
            rain: { '1h': 8.2 },
            dt: Math.floor(Date.now() / 1000),
          },
        }),
      ),
    };
    const service = new WeatherAwarenessService(
      httpService as any,
      configService as any,
      cacheService as any,
    );

    await service.refreshWeatherCache();
    const impact = await service.getRouteImpact(
      [15.3136, -4.3073],
      [15.403, -4.4075],
    );

    expect(httpService.get).toHaveBeenCalledTimes(4);
    expect(cacheService.set).toHaveBeenCalledTimes(4);
    expect(cacheService.set).toHaveBeenCalledWith(expect.any(String), expect.any(Object), 1200);
    expect(impact).toEqual(
      expect.objectContaining({
        heavyRain: true,
        dataAvailable: true,
        priceMultiplier: 1.3,
        etaMultiplier: 1.4,
      }),
    );
  });

  it('returns neutral multipliers when the weather API fails', async () => {
    const httpService = {
      get: jest.fn(() => throwError(() => new Error('provider unavailable'))),
    };
    const service = new WeatherAwarenessService(
      httpService as any,
      configService as any,
      cacheService as any,
    );

    await expect(service.refreshWeatherCache()).resolves.toBeUndefined();
    const impact = await service.getRouteImpact([15.3136, -4.3073], null);

    expect(impact).toEqual(
      expect.objectContaining({
        heavyRain: false,
        dataAvailable: false,
        priceMultiplier: 1,
        etaMultiplier: 1,
      }),
    );
  });

  it('does not reuse old rain data left by the former millisecond TTL', async () => {
    const service = new WeatherAwarenessService({ get: jest.fn(() => throwError(() => new Error('offline'))) } as any, configService as any, cacheService as any);
    cacheService.get.mockResolvedValue({ available: true, heavyRain: true, zoneId: 'old', observedAt: new Date(Date.now() - 86400000).toISOString() });
    const result = await service.getRouteImpact([15.3136, -4.3073], null);
    expect(result).toMatchObject({ dataAvailable: false, heavyRain: false });
  });
});
