import { BadRequestException } from '@nestjs/common';
import { VehicleType } from '../vehicles/entities/vehicle.entity';

export const MINIMUM_TRIP_PRICE_CDF = 2500;
export const NORMAL_PRICE_PER_KM_CDF = 1500;
export const DIFFICULT_PRICE_PER_KM_CDF = 2000;
export const TRAFFIC_DELAY_PRICE_PER_MINUTE_CDF = 120;
export const NORMAL_PRICE_PER_KM_BY_VEHICLE: Readonly<Record<VehicleType, number>> = {
  [VehicleType.CAR]: NORMAL_PRICE_PER_KM_CDF,
  [VehicleType.MOTORCYCLE_TWO_WHEELS]: 1200,
  [VehicleType.MOTORCYCLE_THREE_WHEELS]: 1000,
};
export const TRIP_PRICING_VERSION = '2026-11-13';

export interface PricingRoute {
  distanceMeters: number | null;
  durationSeconds: number | null;
  durationInTrafficSeconds: number | null;
  distanceSource: 'google_directions' | 'straight_line' | 'unavailable';
}

export function assertMinimumTripPrice(price: number): void {
  if (!Number.isFinite(price) || price < MINIMUM_TRIP_PRICE_CDF) {
    throw new BadRequestException({ code: 'TRIP_PRICE_BELOW_MINIMUM',
      message: 'Le prix minimum est de 2 500 FC par place.', minimumPricePerSeat: MINIMUM_TRIP_PRICE_CDF });
  }
}

/** Estimates only. Never use this to reprice an accepted request or payment. */
export function calculateTripRequestPricing(route: PricingRoute, heavyRain: boolean, vehicleType: VehicleType = VehicleType.CAR) {
  const normalRate = NORMAL_PRICE_PER_KM_BY_VEHICLE[vehicleType];
  const finitePositive = (value: number | null): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0;
  const trafficDataAvailable = finitePositive(route.durationSeconds) &&
    finitePositive(route.durationInTrafficSeconds);
  const delaySeconds = trafficDataAvailable
    ? Math.max(0, route.durationInTrafficSeconds! - route.durationSeconds!) : null;
  const heavyTraffic = delaySeconds !== null && delaySeconds >= 300 &&
    route.durationInTrafficSeconds! >= route.durationSeconds! * 1.25;
  const difficultConditions = heavyRain || heavyTraffic;
  const pricePerKmPerPassenger = difficultConditions ? DIFFICULT_PRICE_PER_KM_CDF : normalRate;
  // Pro rata seconds: no rounding a partial minute up to a full billable minute.
  const trafficDelaySurchargePerSeat = heavyTraffic
    ? Math.round(delaySeconds! * TRAFFIC_DELAY_PRICE_PER_MINUTE_CDF / 60) : 0;
  const distancePricePerSeat = finitePositive(route.distanceMeters)
    ? Math.round(route.distanceMeters / 1000 * pricePerKmPerPassenger) : null;
  const recommendedPricePerSeat = distancePricePerSeat === null ? null
    : Math.max(MINIMUM_TRIP_PRICE_CDF, distancePricePerSeat + trafficDelaySurchargePerSeat);
  return {
    pricingVersion: TRIP_PRICING_VERSION,
    vehicleType,
    minimumPricePerSeat: MINIMUM_TRIP_PRICE_CDF,
    normalPricePerKmPerPassenger: normalRate,
    difficultPricePerKmPerPassenger: DIFFICULT_PRICE_PER_KM_CDF,
    pricePerDelayMinute: TRAFFIC_DELAY_PRICE_PER_MINUTE_CDF,
    pricePerKmPerPassenger, recommendedPricePerSeat, distancePricePerSeat,
    trafficDelaySurchargePerSeat,
    minimumPriceAdjustmentPerSeat: recommendedPricePerSeat === null ? null
      : recommendedPricePerSeat - distancePricePerSeat! - trafficDelaySurchargePerSeat,
    heavyRain, heavyTraffic, trafficDataAvailable,
    trafficDelaySeconds: delaySeconds,
    billableDelaySeconds: heavyTraffic ? delaySeconds! : 0,
    distanceMeters: route.distanceMeters,
    durationSeconds: route.durationSeconds,
    durationInTrafficSeconds: route.durationInTrafficSeconds,
    distanceSource: route.distanceSource,
  };
}

export type TripRequestPricing = ReturnType<typeof calculateTripRequestPricing>;
