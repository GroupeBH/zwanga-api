import { calculateInterruptionFare } from './interruption-fare';

describe('driver interruption fare', () => {
  it('charges 20% for 5 km of 25 km', () => {
    expect(calculateInterruptionFare(10000, 10000, 25000, 5000)).toMatchObject({
      passengerAmount: 2000,
      finalAmount: 2000,
      travelledPercentage: 20,
      minimumApplied: false,
    });
  });
  it('applies the 1500 FC minimum to the booking, not to each seat', () => {
    expect(calculateInterruptionFare(6000, 6000, 25000, 5000)).toMatchObject({
      passengerAmount: 1500,
      minimumApplied: true,
    });
  });
  it.each([0, 1000, 1499])(
    'never exceeds an initial price of %s FC',
    (price) => {
      expect(
        calculateInterruptionFare(price, price, 25000, 5000).passengerAmount,
      ).toBe(price);
    },
  );
  it('uses the initial passenger price when a subsidy was applied', () => {
    expect(calculateInterruptionFare(10000, 4000, 25000, 5000)).toMatchObject({
      passengerAmount: 1500,
      finalAmount: 2000,
    });
  });
  it('caps distance and amount at the planned route and agreed price', () => {
    expect(calculateInterruptionFare(5000, 5000, 25000, 30000)).toMatchObject({
      passengerAmount: 5000,
      travelledPercentage: 100,
    });
  });
  it('does not round the distance ratio before calculating the fare', () => {
    expect(calculateInterruptionFare(10000, 10000, 3, 1).passengerAmount).toBe(
      3333.33,
    );
  });
  it.each([
    [NaN, 1, 5, 1],
    [5, Infinity, 5, 1],
    [5, 5, 0, 0],
    [5, 5, 10, -1],
    [5, 10, 10, 1],
  ])('rejects invalid values', (...args) => {
    expect(() =>
      calculateInterruptionFare(...(args as [number, number, number, number])),
    ).toThrow();
  });
});
