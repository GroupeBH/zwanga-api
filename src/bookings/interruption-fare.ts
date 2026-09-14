export const MINIMUM_INTERRUPTION_FARE_CDF = 1500;

export interface InterruptionFareQuote {
  id: string;
  requestId: string;
  bookingId: string;
  currency: 'CDF';
  originalAmount: number;
  originalPassengerAmount: number;
  prepaidAmount: number;
  finalAmount: number;
  passengerAmount: number;
  minimumAmount: number;
  minimumApplied: boolean;
  plannedDistanceMeters: number;
  travelledDistanceMeters: number;
  travelledPercentage: number;
}

/** Money is rounded once to cents; ratios are never rounded before multiplication. */
export function calculateInterruptionFare(
  originalAmount: number,
  originalPassengerAmount: number,
  plannedDistanceMeters: number,
  travelledDistanceMeters: number,
) {
  if (
    ![
      originalAmount,
      originalPassengerAmount,
      plannedDistanceMeters,
      travelledDistanceMeters,
    ].every(Number.isFinite) ||
    originalAmount < 0 ||
    originalPassengerAmount < 0 ||
    originalPassengerAmount > originalAmount ||
    plannedDistanceMeters <= 0 ||
    travelledDistanceMeters < 0
  ) {
    throw new Error('Invalid interruption fare inputs');
  }
  const travelled = Math.min(travelledDistanceMeters, plannedDistanceMeters);
  const ratio = travelled / plannedDistanceMeters;
  const round = (value: number) =>
    Math.round((value + Number.EPSILON) * 100) / 100;
  // A free ride remains free; never charge more than the initial booking amount.
  const minimumAmount = Math.min(
    MINIMUM_INTERRUPTION_FARE_CDF,
    originalPassengerAmount,
  );
  const passengerAmount = Math.min(
    originalPassengerAmount,
    Math.max(minimumAmount, round(originalPassengerAmount * ratio)),
  );
  const finalAmount = Math.min(
    originalAmount,
    Math.max(
      passengerAmount,
      MINIMUM_INTERRUPTION_FARE_CDF,
      round(originalAmount * ratio),
    ),
  );
  return {
    currency: 'CDF' as const,
    originalAmount,
    originalPassengerAmount,
    finalAmount,
    passengerAmount,
    minimumAmount,
    minimumApplied: passengerAmount > round(originalPassengerAmount * ratio),
    plannedDistanceMeters,
    travelledDistanceMeters: travelled,
    travelledPercentage: round(ratio * 100),
  };
}
