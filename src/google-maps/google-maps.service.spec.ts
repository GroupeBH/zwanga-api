import { of } from 'rxjs';
import { GoogleMapsService } from './google-maps.service';

describe('GoogleMapsService directions', () => {
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
