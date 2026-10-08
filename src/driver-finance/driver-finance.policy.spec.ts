import {
  cashCommissionTokens,
  DRIVER_FINANCE,
  normalizeAcceptedPaymentModes,
} from './driver-finance.policy';
import { TripPaymentMode } from '../payments/enums/trip-payment-mode.enum';

describe('driver finance policy', () => {
  it('separates the 5000 CDF Pro entitlement from the ever-due 5% commission', () => {
    expect(DRIVER_FINANCE).toEqual({
      proPrice: 5000,
      currency: 'CDF',
      durationDays: 30,
      commissionRate: 0.05,
      cashCommissionRate: 0.05,
      cashDebtLimitTokens: 25,
    });
    expect(cashCommissionTokens(100000, 100)).toBe(50);
    expect(cashCommissionTokens(200000, 100)).toBe(100);
    expect(cashCommissionTokens(5000, 100)).toBe(2.5);
  });
  it('validates modes and preserves defaults for old clients without silently forcing cash', () => {
    expect(normalizeAcceptedPaymentModes()).toEqual(
      Object.values(TripPaymentMode),
    );
    expect(
      normalizeAcceptedPaymentModes([
        TripPaymentMode.POINTS,
        TripPaymentMode.POINTS,
      ]),
    ).toEqual([TripPaymentMode.POINTS]);
    expect(() => normalizeAcceptedPaymentModes([])).toThrow();
    expect(() =>
      normalizeAcceptedPaymentModes(['invalid' as TripPaymentMode]),
    ).toThrow();
  });
  it.each([
    [-1, 100],
    [100, 0],
    [NaN, 100],
    [100, Infinity],
  ])('rejects invalid amount/conversion %s %s', (amount, value) => {
    expect(() => cashCommissionTokens(amount, value)).toThrow();
  });
});
