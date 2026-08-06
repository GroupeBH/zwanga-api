export interface BoardingDetectionConfig {
  minimumRadiusMeters: number;
  maximumRadiusMeters: number;
  safetyMarginMeters: number;
  maximumAcceptedAccuracyMeters: number;
  maximumLocationAgeMs: number;
  maximumTimestampDifferenceMs: number;
  driverMinimumMovementMeters: number;
  passengerMinimumMovementMeters: number;
  maximumHeadingDifferenceDegrees: number;
  maximumSpeedDifferenceKmh: number;
  windowSize: number;
  minimumValidSamples: number;
  minimumCloseSamplesRatio: number;
  minimumSharedMovementDurationMs: number;
  minimumSharedDistanceMeters: number;
  slowTrafficObservationDurationMs: number;
  slowTrafficMaximumSpeedKmh: number;
  slowTrafficMinimumSharedDistanceMeters: number;
  maximumContinuousSeparationDurationMs: number;
  candidateExpirationMs: number;
  confirmationScore: number;
  maximumPlausibleSpeedMetersPerSecond: number;
}

export const DEFAULT_BOARDING_DETECTION_CONFIG: Readonly<BoardingDetectionConfig> =
  Object.freeze({
    minimumRadiusMeters: 25,
    maximumRadiusMeters: 60,
    safetyMarginMeters: 10,
    maximumAcceptedAccuracyMeters: 70,
    maximumLocationAgeMs: 10_000,
    maximumTimestampDifferenceMs: 5_000,
    driverMinimumMovementMeters: 30,
    passengerMinimumMovementMeters: 20,
    maximumHeadingDifferenceDegrees: 35,
    maximumSpeedDifferenceKmh: 10,
    windowSize: 10,
    minimumValidSamples: 7,
    minimumCloseSamplesRatio: 0.7,
    minimumSharedMovementDurationMs: 20_000,
    minimumSharedDistanceMeters: 80,
    slowTrafficObservationDurationMs: 60_000,
    slowTrafficMaximumSpeedKmh: 12,
    slowTrafficMinimumSharedDistanceMeters: 30,
    maximumContinuousSeparationDurationMs: 10_000,
    candidateExpirationMs: 10 * 60_000,
    confirmationScore: 80,
    maximumPlausibleSpeedMetersPerSecond: 70,
  });

type ConfigReader = {
  get<T = string>(key: string): T | undefined;
};

const CONFIG_KEYS: Record<keyof BoardingDetectionConfig, string> = {
  minimumRadiusMeters: 'BOARDING_MINIMUM_RADIUS_METERS',
  maximumRadiusMeters: 'BOARDING_MAXIMUM_RADIUS_METERS',
  safetyMarginMeters: 'BOARDING_SAFETY_MARGIN_METERS',
  maximumAcceptedAccuracyMeters: 'BOARDING_MAXIMUM_ACCEPTED_ACCURACY_METERS',
  maximumLocationAgeMs: 'BOARDING_MAXIMUM_LOCATION_AGE_MS',
  maximumTimestampDifferenceMs: 'BOARDING_MAXIMUM_TIMESTAMP_DIFFERENCE_MS',
  driverMinimumMovementMeters: 'BOARDING_DRIVER_MINIMUM_MOVEMENT_METERS',
  passengerMinimumMovementMeters: 'BOARDING_PASSENGER_MINIMUM_MOVEMENT_METERS',
  maximumHeadingDifferenceDegrees:
    'BOARDING_MAXIMUM_HEADING_DIFFERENCE_DEGREES',
  maximumSpeedDifferenceKmh: 'BOARDING_MAXIMUM_SPEED_DIFFERENCE_KMH',
  windowSize: 'BOARDING_WINDOW_SIZE',
  minimumValidSamples: 'BOARDING_MINIMUM_VALID_SAMPLES',
  minimumCloseSamplesRatio: 'BOARDING_MINIMUM_CLOSE_SAMPLES_RATIO',
  minimumSharedMovementDurationMs:
    'BOARDING_MINIMUM_SHARED_MOVEMENT_DURATION_MS',
  minimumSharedDistanceMeters: 'BOARDING_MINIMUM_SHARED_DISTANCE_METERS',
  slowTrafficObservationDurationMs:
    'BOARDING_SLOW_TRAFFIC_OBSERVATION_DURATION_MS',
  slowTrafficMaximumSpeedKmh: 'BOARDING_SLOW_TRAFFIC_MAXIMUM_SPEED_KMH',
  slowTrafficMinimumSharedDistanceMeters:
    'BOARDING_SLOW_TRAFFIC_MINIMUM_SHARED_DISTANCE_METERS',
  maximumContinuousSeparationDurationMs:
    'BOARDING_MAXIMUM_CONTINUOUS_SEPARATION_DURATION_MS',
  candidateExpirationMs: 'BOARDING_CANDIDATE_EXPIRATION_MS',
  confirmationScore: 'BOARDING_CONFIRMATION_SCORE',
  maximumPlausibleSpeedMetersPerSecond:
    'BOARDING_MAXIMUM_PLAUSIBLE_SPEED_METERS_PER_SECOND',
};

export function loadBoardingDetectionConfig(
  configService: ConfigReader,
): BoardingDetectionConfig {
  return Object.fromEntries(
    Object.entries(CONFIG_KEYS).map(([property, key]) => {
      const fallback =
        DEFAULT_BOARDING_DETECTION_CONFIG[
          property as keyof BoardingDetectionConfig
        ];
      const configured = Number(configService.get(key));
      return [
        property,
        Number.isFinite(configured) && configured >= 0 ? configured : fallback,
      ];
    }),
  ) as unknown as BoardingDetectionConfig;
}
