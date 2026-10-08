import { BadRequestException } from '@nestjs/common';
import { TripPaymentMode } from '../payments/enums/trip-payment-mode.enum';

export const DRIVER_FINANCE = Object.freeze({
  commissionRate: 0.05,
  cashCommissionRate: 0.05,
  cashDebtLimitTokens: 25,
  proPrice: 5000,
  currency: 'CDF',
  durationDays: 30,
});
export const ALL_TRIP_PAYMENT_MODES = Object.values(TripPaymentMode);

export function normalizeAcceptedPaymentModes(
  modes?: TripPaymentMode[],
): TripPaymentMode[] {
  if (modes !== undefined && !Array.isArray(modes)) {
    throw new BadRequestException(
      'Choisissez au moins un mode de paiement valide.',
    );
  }
  const result =
    modes === undefined ? [...ALL_TRIP_PAYMENT_MODES] : [...new Set(modes)];
  if (
    !result.length ||
    result.some((mode) => !ALL_TRIP_PAYMENT_MODES.includes(mode))
  ) {
    throw new BadRequestException(
      'Choisissez au moins un mode de paiement valide.',
    );
  }
  return result;
}

/** The same two-decimal token rounding as the existing wallet conversion. */
export function cashCommissionTokens(
  amount: number,
  moneyPerToken: number,
  rate = DRIVER_FINANCE.cashCommissionRate,
): number {
  if (
    !Number.isFinite(amount) ||
    amount < 0 ||
    !Number.isFinite(moneyPerToken) ||
    moneyPerToken <= 0
  ) {
    throw new BadRequestException(
      'Montant ou conversion de commission invalide.',
    );
  }
  return (
    Math.round(
      (Math.round(amount * rate * 100) /
        100 /
        moneyPerToken) *
        100,
    ) / 100
  );
}
