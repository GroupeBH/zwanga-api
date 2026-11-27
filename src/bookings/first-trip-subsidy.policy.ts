/** Business ceiling confirmed on 2026-11-26. Per booking, not per seat. CDF only. */
export const FIRST_TRIP_SUBSIDY_CAP_CDF = 7_500;

export function cappedFirstTripFare(gross: number, passengerRate: number) {
  if (
    !Number.isFinite(gross) ||
    gross <= 0 ||
    !Number.isFinite(passengerRate) ||
    passengerRate <= 0 ||
    passengerRate >= 1
  ) {
    throw new Error('Invalid first-trip fare');
  }
  const grossMinor = Math.round(gross * 100);
  const subsidyMinor = Math.min(
    FIRST_TRIP_SUBSIDY_CAP_CDF * 100,
    grossMinor - Math.round(grossMinor * passengerRate),
  );
  return {
    passengerAmount: (grossMinor - subsidyMinor) / 100,
    subsidyAmount: subsidyMinor / 100,
  };
}
