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
