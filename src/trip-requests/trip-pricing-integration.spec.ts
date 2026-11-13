import { TripRequestsService } from './trip-requests.service';
import { VehicleType } from '../vehicles/entities/vehicle.entity';

describe('pricing integration with route and weather providers mocked', () => {
  function fixture(legs: any[], rain = false) {
    const maps = { getDirections: jest.fn().mockResolvedValue({ routes: [{ legs }] }) };
    const weather = { getRouteImpact: jest.fn().mockResolvedValue({ heavyRain: rain,
      priceMultiplier: rain ? 1.3 : 1, dataAvailable: true, etaMultiplier: 1,
      affectedZoneIds: [], evaluatedZoneIds: [] }) };
    const service = new TripRequestsService({} as any, {} as any, {} as any, {} as any,
      {} as any, {} as any, {} as any, {} as any, maps as any, {} as any, weather as any, {} as any);
    jest.spyOn(service as any, 'resolvePointFromCoordinatesOrAddress')
      .mockResolvedValueOnce({ type: 'Point', coordinates: [15.3, -4.3] })
      .mockResolvedValueOnce({ type: 'Point', coordinates: [15.4, -4.4] });
    return { service, maps };
  }
  it('retains the common difficult rate, with explicit delay and the correct seat total', async () => {
    const { service, maps } = fixture([{ distance: 5000, duration: 1200, durationInTraffic: 1800 }], true);
    const result = await service.getVehicleOptions({ numberOfSeats: 2 });
    expect(maps.getDirections).toHaveBeenCalledTimes(1);
    expect(maps.getDirections).toHaveBeenCalledWith(expect.objectContaining({ departureTime: expect.any(Number) }));
    expect(result.pricing).toMatchObject({ heavyTraffic: true, heavyRain: true, billableDelaySeconds: 600,
      trafficDelaySurchargePerSeat: 1200, recommendedPricePerSeat: 11200, pricingVersion: '2026-11-13' });
    for (const option of result.options) expect(option).toMatchObject({
      pricePerKmPerPassenger: 2000, recommendedPricePerSeat: 11200, recommendedTotalPrice: 22400,
    });
  });
  it.each([
    { name: 'minimum', distance: 1000, duration: 1200, traffic: 1200, rain: false, rate: 1500, price: 2500 },
    { name: '3.3 km normal route', distance: 3300, duration: 1200, traffic: 1200, rain: false, rate: 1500, price: 4950 },
    { name: 'normal route', distance: 5000, duration: 1200, traffic: 1200, rain: false, rate: 1500, price: 7500 },
    { name: 'rain only', distance: 5000, duration: 1200, traffic: 1200, rain: true, rate: 2000, price: 10000 },
    { name: 'heavy traffic only', distance: 5000, duration: 1200, traffic: 1800, rain: false, rate: 2000, price: 11200 },
    { name: 'rain and heavy traffic', distance: 5000, duration: 1200, traffic: 1800, rain: true, rate: 2000, price: 11200 },
    { name: 'rain below heavy traffic threshold', distance: 5000, duration: 1200, traffic: 1440, rain: true, rate: 2000, price: 10000 },
    { name: 'missing traffic data', distance: 5000, duration: 1200, traffic: undefined, rain: false, rate: 1500, price: 7500 },
  ])('vehicle cards and single-vehicle recommendations agree: $name', async (scenario) => {
    const legs = [{ distance: scenario.distance, duration: scenario.duration, durationInTraffic: scenario.traffic }];
    for (const numberOfSeats of [1, 2]) {
      const { service, maps } = fixture(legs, scenario.rain);
      const result = await service.getVehicleOptions({ numberOfSeats });
      expect(result.options.map(option => option.vehicleType)).toEqual(Object.values(VehicleType));
      expect(maps.getDirections).toHaveBeenCalledTimes(1);
      for (const option of result.options) {
        const normalRates = { [VehicleType.CAR]: 1500,
          [VehicleType.MOTORCYCLE_TWO_WHEELS]: 1200, [VehicleType.MOTORCYCLE_THREE_WHEELS]: 1000 };
        const rate = scenario.rate === 2000 ? 2000 : normalRates[option.vehicleType];
        const price = scenario.rate === 2000 ? scenario.price : Math.max(2500, scenario.distance / 1000 * rate);
        const single = await fixture(legs, scenario.rain).service.recommendPrice({
          vehicleType: option.vehicleType, numberOfSeats,
        });
        expect(option).toMatchObject({ availableForRequestedSeats: true,
          pricePerKmPerPassenger: rate, recommendedPricePerSeat: price,
          recommendedTotalPrice: price * numberOfSeats });
        expect(option.pricing).toEqual(single.pricing);
        expect(option.recommendedPricePerSeat).toBe(single.recommendedPricePerSeat);
        expect(option.recommendedTotalPrice).toBe(single.recommendedTotalPrice);
      }
    }
  });
  it('keeps the seat limits when returning the new estimates', async () => {
    const { service } = fixture([{ distance: 5000, duration: 1200, durationInTraffic: 1200 }]);
    const result = await service.getVehicleOptions({ numberOfSeats: 3 });
    expect(result.options).toEqual([
      expect.objectContaining({ vehicleType: VehicleType.CAR, availableForRequestedSeats: true, recommendedTotalPrice: 22500 }),
      expect.objectContaining({ vehicleType: VehicleType.MOTORCYCLE_TWO_WHEELS, availableForRequestedSeats: false, recommendedTotalPrice: 18000 }),
      expect.objectContaining({ vehicleType: VehicleType.MOTORCYCLE_THREE_WHEELS, availableForRequestedSeats: true, recommendedTotalPrice: 15000 }),
    ]);
  });
  it.each([
    [VehicleType.CAR, 7500],
    [VehicleType.MOTORCYCLE_TWO_WHEELS, 6000],
    [VehicleType.MOTORCYCLE_THREE_WHEELS, 5000],
  ])('uses the same vehicle rate for the creation default: %s', async (type, expected) => {
    const { service } = fixture([{ distance: 5000, duration: 1200, durationInTraffic: 1200 }]);
    const point = { type: 'Point', coordinates: [15.3, -4.3] };
    expect(await (service as any).calculateRecommendedPricePerSeat(point, point, type, 'test'))
      .toBe(expected);
  });
  it('does not bill an incomplete traffic route as if all legs were known', async () => {
    const { service } = fixture([{ distance: 2000, duration: 500, durationInTraffic: 900 }, { distance: 3000, duration: 700 }]);
    const result = await service.recommendPrice({ vehicleType: VehicleType.CAR });
    expect(result.pricing).toMatchObject({ trafficDataAvailable: false, trafficDelaySeconds: null, recommendedPricePerSeat: 7500 });
  });
  it('marks fallback distance as approximate and never invents congestion after a provider failure', async () => {
    const { service, maps } = fixture([]);
    maps.getDirections.mockRejectedValue(new Error('synthetic provider failure'));
    const result = await service.getVehicleOptions({});
    expect(result.pricing).toMatchObject({ distanceSource: 'straight_line', trafficDataAvailable: false,
      heavyTraffic: false, trafficDelaySurchargePerSeat: 0 });
    expect(result.distanceMeters).toBeGreaterThan(0);
  });
});
