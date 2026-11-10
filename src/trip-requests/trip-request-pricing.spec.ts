import { assertMinimumTripPrice, calculateTripRequestPricing, PricingRoute } from './trip-request-pricing';

const route = (overrides: Partial<PricingRoute> = {}): PricingRoute => ({
  distanceMeters: 5000, durationSeconds: 1200, durationInTrafficSeconds: 1200,
  distanceSource: 'google_directions', ...overrides,
});

describe('CDF pricing grid 2026-11-10', () => {
  it('charges 1500/km normally and enforces the minimum on short routes', () => {
    expect(calculateTripRequestPricing(route(), false).recommendedPricePerSeat).toBe(7500);
    expect(calculateTripRequestPricing(route({ distanceMeters: 400 }), false)).toMatchObject({
      recommendedPricePerSeat: 2500, distancePricePerSeat: 600, minimumPriceAdjustmentPerSeat: 1900,
    });
  });
  it('uses 2000/km for rain without inventing delay or applying the former multiplier', () => {
    expect(calculateTripRequestPricing(route(), true)).toMatchObject({
      recommendedPricePerSeat: 10000, trafficDelaySurchargePerSeat: 0, heavyRain: true,
    });
  });
  it.each([false, true])('bills only the traffic delay, once, including when rain=%s', rain => {
    expect(calculateTripRequestPricing(route({ durationInTrafficSeconds: 1800 }), rain)).toMatchObject({
      recommendedPricePerSeat: 11200, trafficDelaySurchargePerSeat: 1200,
      trafficDelaySeconds: 600, billableDelaySeconds: 600, heavyTraffic: true,
    });
  });
  it('requires both 25 percent and five minutes, inclusively', () => {
    expect(calculateTripRequestPricing(route({ durationInTrafficSeconds: 1500 }), false).heavyTraffic).toBe(true);
    for (const durations of [[1200, 1499], [3000, 3600], [300, 450]]) {
      expect(calculateTripRequestPricing(route({ durationSeconds: durations[0], durationInTrafficSeconds: durations[1] }), false))
        .toMatchObject({ heavyTraffic: false, trafficDelaySurchargePerSeat: 0, pricePerKmPerPassenger: 1500 });
    }
  });
  it('does not charge small delays even in rain', () => {
    expect(calculateTripRequestPricing(route({ durationInTrafficSeconds: 1250 }), true))
      .toMatchObject({ recommendedPricePerSeat: 10000, billableDelaySeconds: 0 });
  });
  it('calculates partial minutes proportionally and ignores negative delays', () => {
    expect(calculateTripRequestPricing(route({ durationInTrafficSeconds: 1515 }), false).trafficDelaySurchargePerSeat).toBe(630);
    expect(calculateTripRequestPricing(route({ durationInTrafficSeconds: 1000 }), false).trafficDelaySeconds).toBe(0);
  });
  it.each([null, NaN, Infinity, -1, 0])('does not invent traffic when a duration is %s', value => {
    for (const input of [{ durationSeconds: value }, { durationInTrafficSeconds: value }]) {
      expect(calculateTripRequestPricing(route(input), false)).toMatchObject({
        trafficDataAvailable: false, trafficDelaySeconds: null, billableDelaySeconds: 0, recommendedPricePerSeat: 7500,
      });
    }
  });
  it.each([null, NaN, Infinity, -1, 0])('does not invent a fare when distance is %s', distanceMeters => {
    expect(calculateTripRequestPricing(route({ distanceMeters }), false).recommendedPricePerSeat).toBeNull();
  });
  it.each([0, 500, 1945, 2499, NaN, Infinity])('rejects a new manually supplied price %s below the floor', price => {
    expect(() => assertMinimumTripPrice(price)).toThrow('Le prix minimum est de 2 500 FC par place.');
  });
  it.each([2500, 7500, 11200])('preserves a valid passenger budget %s', price => {
    expect(() => assertMinimumTripPrice(price)).not.toThrow();
  });
});
