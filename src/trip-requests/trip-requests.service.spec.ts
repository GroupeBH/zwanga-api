import { TripRequestsService } from './trip-requests.service';

describe('TripRequestsService weather-aware recommended price', () => {
  it('applies the heavy-rain coefficient after the distance pricing tiers', async () => {
    const weatherAwarenessService = {
      getRouteImpact: jest.fn().mockResolvedValue({
        heavyRain: true,
        dataAvailable: true,
        priceMultiplier: 1.3,
        etaMultiplier: 1.4,
        evaluatedZoneIds: ['cd-kinshasa-gombe'],
        affectedZoneIds: ['cd-kinshasa-gombe'],
      }),
    };
    const service = new TripRequestsService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      weatherAwarenessService as any,
    );
    jest
      .spyOn(service as any, 'resolvePointFromCoordinatesOrAddress')
      .mockResolvedValueOnce({
        type: 'Point',
        coordinates: [15.3136, -4.3073],
      })
      .mockResolvedValueOnce({
        type: 'Point',
        coordinates: [15.403, -4.4075],
      });
    jest
      .spyOn(service as any, 'calculateRouteDistanceMeters')
      .mockResolvedValue(5000);

    const recommendation = await service.recommendPrice({
      departureLocation: 'Gombe',
      arrivalLocation: "N'djili",
      numberOfSeats: 2,
    });

    expect(recommendation.recommendedPricePerSeat).toBe(19500);
    expect(recommendation.recommendedTotalPrice).toBe(39000);
    expect(recommendation.weatherImpact.priceMultiplier).toBe(1.3);
  });
});
