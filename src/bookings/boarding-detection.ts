import {
  BoardingDetectionConfig,
  DEFAULT_BOARDING_DETECTION_CONFIG,
} from './boarding-detection.config';

export enum BoardingDetectionState {
  DRIVER_APPROACHING = 'DRIVER_APPROACHING',
  BOARDING_CANDIDATE = 'BOARDING_CANDIDATE',
  SHARED_MOVEMENT_DETECTED = 'SHARED_MOVEMENT_DETECTED',
  BOARDING_CONFIRMED = 'BOARDING_CONFIRMED',
  BOARDING_CANDIDATE_EXPIRED = 'BOARDING_CANDIDATE_EXPIRED',
  BOARDING_REJECTED = 'BOARDING_REJECTED',
}

export enum BoardingRejectionReason {
  LOCATION_MISSING = 'LOCATION_MISSING',
  LOCATION_STALE = 'LOCATION_STALE',
  GPS_ACCURACY_TOO_LOW = 'GPS_ACCURACY_TOO_LOW',
  TIMESTAMPS_TOO_FAR_APART = 'TIMESTAMPS_TOO_FAR_APART',
  NOT_CLOSE_ENOUGH = 'NOT_CLOSE_ENOUGH',
  NOT_ENOUGH_DRIVER_MOVEMENT = 'NOT_ENOUGH_DRIVER_MOVEMENT',
  NOT_ENOUGH_PASSENGER_MOVEMENT = 'NOT_ENOUGH_PASSENGER_MOVEMENT',
  DIRECTION_UNAVAILABLE = 'DIRECTION_UNAVAILABLE',
  DIRECTION_MISMATCH = 'DIRECTION_MISMATCH',
  SPEED_MISMATCH = 'SPEED_MISMATCH',
  PROXIMITY_NOT_STABLE = 'PROXIMITY_NOT_STABLE',
  SHARED_MOVEMENT_TOO_SHORT = 'SHARED_MOVEMENT_TOO_SHORT',
  SHARED_DISTANCE_TOO_SHORT = 'SHARED_DISTANCE_TOO_SHORT',
  PASSENGER_LOCATION_INACTIVE = 'PASSENGER_LOCATION_INACTIVE',
  INVALID_STATE_TRANSITION = 'INVALID_STATE_TRANSITION',
  IMPOSSIBLE_GPS_JUMP = 'IMPOSSIBLE_GPS_JUMP',
}

export interface BoardingLocationSample {
  latitude: number;
  longitude: number;
  recordedAt: string;
  accuracyMeters: number | null;
  speedMetersPerSecond: number | null;
  headingDegrees: number | null;
}

export interface BoardingCandidateSnapshot {
  state: BoardingDetectionState;
  previousState: BoardingDetectionState;
  createdAt: string;
  updatedAt: string;
  initialDriverLocation: BoardingLocationSample;
  initialPassengerLocation: BoardingLocationSample;
  sharedMovementStartedAt: string | null;
  separationStartedAt: string | null;
  confirmedAt: string | null;
}

export type BoardingDecision = 'CONFIRM' | 'OBSERVE' | 'REJECT';

export interface BoardingDetectionMetrics {
  currentState: BoardingDetectionState;
  previousState: BoardingDetectionState;
  driverLocationTimestamp: string | null;
  passengerLocationTimestamp: string | null;
  driverLocationAge: number | null;
  passengerLocationAge: number | null;
  driverAccuracy: number | null;
  passengerAccuracy: number | null;
  distanceBetweenUsers: number | null;
  pickupRadius: number;
  driverSpeed: number | null;
  passengerSpeed: number | null;
  driverHeading: number | null;
  passengerHeading: number | null;
  headingDifference: number | null;
  speedDifference: number | null;
  driverDistanceMoved: number;
  passengerDistanceMoved: number;
  sharedMovementDuration: number;
  sharedDistance: number;
  closeSamplesRatio: number;
  validSamples: number;
  confidenceScore: number;
  slowTrafficPath: boolean;
  decision: BoardingDecision;
  rejectionReason: BoardingRejectionReason | null;
}

export interface BoardingDetectionInput {
  now?: Date;
  stateCompatible: boolean;
  pickupLocation: { latitude: number; longitude: number } | null;
  driverLocations: BoardingLocationSample[];
  passengerLocations: BoardingLocationSample[];
  candidate: BoardingCandidateSnapshot | null;
  config?: BoardingDetectionConfig;
}

export interface BoardingDetectionResult {
  decision: BoardingDecision;
  rejectionReason: BoardingRejectionReason | null;
  candidate: BoardingCandidateSnapshot | null;
  metrics: BoardingDetectionMetrics;
}

type Coordinate = Pick<BoardingLocationSample, 'latitude' | 'longitude'>;
type PairedSample = {
  driver: BoardingLocationSample;
  passenger: BoardingLocationSample;
  distanceMeters: number;
};

const EARTH_RADIUS_METERS = 6_371_000;

export function angleDifference(a: number, b: number): number {
  const difference = Math.abs(a - b) % 360;
  return Math.min(difference, 360 - difference);
}

export function calculateBoardingDistanceMeters(
  first: Coordinate,
  second: Coordinate,
): number {
  const toRadians = (value: number) => (value * Math.PI) / 180;
  const deltaLatitude = toRadians(second.latitude - first.latitude);
  const deltaLongitude = toRadians(second.longitude - first.longitude);
  const firstLatitude = toRadians(first.latitude);
  const secondLatitude = toRadians(second.latitude);
  const haversine =
    Math.sin(deltaLatitude / 2) ** 2 +
    Math.cos(firstLatitude) *
      Math.cos(secondLatitude) *
      Math.sin(deltaLongitude / 2) ** 2;

  return (
    EARTH_RADIUS_METERS *
    2 *
    Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine))
  );
}

function calculateBearingDegrees(first: Coordinate, second: Coordinate) {
  const toRadians = (value: number) => (value * Math.PI) / 180;
  const firstLatitude = toRadians(first.latitude);
  const secondLatitude = toRadians(second.latitude);
  const longitudeDelta = toRadians(second.longitude - first.longitude);
  const y = Math.sin(longitudeDelta) * Math.cos(secondLatitude);
  const x =
    Math.cos(firstLatitude) * Math.sin(secondLatitude) -
    Math.sin(firstLatitude) *
      Math.cos(secondLatitude) *
      Math.cos(longitudeDelta);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

function clamp(minimum: number, value: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function timestamp(sample: BoardingLocationSample) {
  return new Date(sample.recordedAt).getTime();
}

function sortedSamples(samples: BoardingLocationSample[]) {
  return samples
    .filter(
      (sample) =>
        Number.isFinite(sample.latitude) &&
        Number.isFinite(sample.longitude) &&
        Number.isFinite(timestamp(sample)),
    )
    .sort((left, right) => timestamp(left) - timestamp(right));
}

function withCandidateAnchor(
  samples: BoardingLocationSample[],
  anchor: BoardingLocationSample,
  windowSize: number,
) {
  const afterCandidate = sortedSamples(samples).filter(
    (sample) => timestamp(sample) >= timestamp(anchor),
  );
  const withoutDuplicateAnchor = afterCandidate.filter(
    (sample) =>
      timestamp(sample) !== timestamp(anchor) ||
      calculateBoardingDistanceMeters(sample, anchor) > 0.5,
  );
  const tail = withoutDuplicateAnchor.slice(-Math.max(1, windowSize - 1));
  return [anchor, ...tail];
}

function pairSamples(
  driverSamples: BoardingLocationSample[],
  passengerSamples: BoardingLocationSample[],
  maximumDifferenceMs: number,
): PairedSample[] {
  const iterateDrivers = driverSamples.length >= passengerSamples.length;
  const primary = iterateDrivers ? driverSamples : passengerSamples;
  const secondary = iterateDrivers ? passengerSamples : driverSamples;

  return primary.flatMap((primarySample) => {
    const closest = secondary.reduce<BoardingLocationSample | null>(
      (best, candidate) => {
        if (!best) return candidate;
        const candidateTimestampDifference = Math.abs(
          timestamp(primarySample) - timestamp(candidate),
        );
        const bestTimestampDifference = Math.abs(
          timestamp(primarySample) - timestamp(best),
        );
        if (candidateTimestampDifference !== bestTimestampDifference) {
          return candidateTimestampDifference < bestTimestampDifference
            ? candidate
            : best;
        }
        return calculateBoardingDistanceMeters(primarySample, candidate) <
          calculateBoardingDistanceMeters(primarySample, best)
          ? candidate
          : best;
      },
      null,
    );
    if (
      !closest ||
      Math.abs(timestamp(primarySample) - timestamp(closest)) >
        maximumDifferenceMs
    ) {
      return [];
    }

    const driver = iterateDrivers ? primarySample : closest;
    const passenger = iterateDrivers ? closest : primarySample;
    return [
      {
        driver,
        passenger,
        distanceMeters: calculateBoardingDistanceMeters(driver, passenger),
      },
    ];
  });
}

function pathDistance(samples: BoardingLocationSample[]) {
  return samples
    .slice(1)
    .reduce(
      (total, sample, index) =>
        total + calculateBoardingDistanceMeters(samples[index], sample),
      0,
    );
}

function derivedSpeedKmh(samples: BoardingLocationSample[]) {
  if (samples.length < 2) return null;
  const durationMs = timestamp(samples.at(-1)!) - timestamp(samples[0]);
  if (durationMs <= 0) return null;
  return (pathDistance(samples) / (durationMs / 1_000)) * 3.6;
}

function weightedBearing(samples: BoardingLocationSample[]) {
  let x = 0;
  let y = 0;
  let weight = 0;

  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1];
    const current = samples[index];
    const distance = calculateBoardingDistanceMeters(previous, current);
    if (distance < 3) continue;
    const bearingRadians =
      (calculateBearingDegrees(previous, current) * Math.PI) / 180;
    x += Math.cos(bearingRadians) * distance;
    y += Math.sin(bearingRadians) * distance;
    weight += distance;
  }

  return weight > 0 ? ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360 : null;
}

function hasImpossibleJump(
  samples: BoardingLocationSample[],
  maximumSpeedMetersPerSecond: number,
) {
  for (let index = 1; index < samples.length; index += 1) {
    const durationSeconds =
      (timestamp(samples[index]) - timestamp(samples[index - 1])) / 1_000;
    if (durationSeconds <= 0) continue;
    if (
      calculateBoardingDistanceMeters(samples[index - 1], samples[index]) /
        durationSeconds >
      maximumSpeedMetersPerSecond
    ) {
      return true;
    }
  }
  return false;
}

function firstMovementTimestamp(
  samples: BoardingLocationSample[],
  anchor: BoardingLocationSample,
  movementMeters: number,
) {
  return (
    samples.find(
      (sample) =>
        calculateBoardingDistanceMeters(anchor, sample) >= movementMeters,
    )?.recordedAt ?? null
  );
}

function synchronizedMovementRatio(pairs: PairedSample[]) {
  if (pairs.length < 2) return 0;
  let synchronized = 0;
  let comparableIntervals = 0;
  for (let index = 1; index < pairs.length; index += 1) {
    if (
      pairs[index - 1].driver.recordedAt === pairs[index].driver.recordedAt ||
      pairs[index - 1].passenger.recordedAt ===
        pairs[index].passenger.recordedAt
    ) {
      continue;
    }
    comparableIntervals += 1;
    const driverMoved = calculateBoardingDistanceMeters(
      pairs[index - 1].driver,
      pairs[index].driver,
    );
    const passengerMoved = calculateBoardingDistanceMeters(
      pairs[index - 1].passenger,
      pairs[index].passenger,
    );
    if (driverMoved >= 2 && passengerMoved >= 2) synchronized += 1;
  }
  return comparableIntervals > 0 ? synchronized / comparableIntervals : 0;
}

function buildInitialMetrics(
  state: BoardingDetectionState,
  previousState: BoardingDetectionState,
  pickupRadius: number,
): BoardingDetectionMetrics {
  return {
    currentState: state,
    previousState,
    driverLocationTimestamp: null,
    passengerLocationTimestamp: null,
    driverLocationAge: null,
    passengerLocationAge: null,
    driverAccuracy: null,
    passengerAccuracy: null,
    distanceBetweenUsers: null,
    pickupRadius,
    driverSpeed: null,
    passengerSpeed: null,
    driverHeading: null,
    passengerHeading: null,
    headingDifference: null,
    speedDifference: null,
    driverDistanceMoved: 0,
    passengerDistanceMoved: 0,
    sharedMovementDuration: 0,
    sharedDistance: 0,
    closeSamplesRatio: 0,
    validSamples: 0,
    confidenceScore: 0,
    slowTrafficPath: false,
    decision: 'OBSERVE',
    rejectionReason: null,
  };
}

export function evaluateBoardingDetection(
  input: BoardingDetectionInput,
): BoardingDetectionResult {
  const config = input.config ?? DEFAULT_BOARDING_DETECTION_CONFIG;
  const now = input.now ?? new Date();
  const nowMs = now.getTime();
  const driverLocations = sortedSamples(input.driverLocations);
  const passengerLocations = sortedSamples(input.passengerLocations);
  const driverCurrent = driverLocations.at(-1) ?? null;
  const passengerCurrent = passengerLocations.at(-1) ?? null;
  let candidate = input.candidate;
  let currentState =
    candidate?.state ?? BoardingDetectionState.DRIVER_APPROACHING;
  let previousState = candidate?.previousState ?? currentState;
  let pickupRadius = config.minimumRadiusMeters;
  const metrics = buildInitialMetrics(
    currentState,
    previousState,
    pickupRadius,
  );

  const finish = (
    decision: BoardingDecision,
    rejectionReason: BoardingRejectionReason | null,
    nextCandidate = candidate,
  ): BoardingDetectionResult => {
    metrics.currentState = nextCandidate?.state ?? currentState;
    metrics.previousState = nextCandidate?.previousState ?? previousState;
    metrics.decision = decision;
    metrics.rejectionReason = rejectionReason;
    return { decision, rejectionReason, candidate: nextCandidate, metrics };
  };

  if (!input.stateCompatible) {
    currentState = BoardingDetectionState.BOARDING_REJECTED;
    const rejectedCandidate = candidate
      ? {
          ...candidate,
          state: currentState,
          previousState,
          updatedAt: now.toISOString(),
        }
      : null;
    return finish(
      'REJECT',
      BoardingRejectionReason.INVALID_STATE_TRANSITION,
      rejectedCandidate,
    );
  }

  if (!driverCurrent || !passengerCurrent) {
    return finish('REJECT', BoardingRejectionReason.LOCATION_MISSING);
  }

  metrics.driverLocationTimestamp = driverCurrent.recordedAt;
  metrics.passengerLocationTimestamp = passengerCurrent.recordedAt;
  metrics.driverLocationAge = Math.max(0, nowMs - timestamp(driverCurrent));
  metrics.passengerLocationAge = Math.max(
    0,
    nowMs - timestamp(passengerCurrent),
  );
  metrics.driverAccuracy = driverCurrent.accuracyMeters;
  metrics.passengerAccuracy = passengerCurrent.accuracyMeters;

  if (
    metrics.driverLocationAge > config.maximumLocationAgeMs ||
    metrics.passengerLocationAge > config.maximumLocationAgeMs
  ) {
    return finish('REJECT', BoardingRejectionReason.LOCATION_STALE);
  }

  if (
    driverCurrent.accuracyMeters === null ||
    passengerCurrent.accuracyMeters === null ||
    driverCurrent.accuracyMeters > config.maximumAcceptedAccuracyMeters ||
    passengerCurrent.accuracyMeters > config.maximumAcceptedAccuracyMeters
  ) {
    return finish('REJECT', BoardingRejectionReason.GPS_ACCURACY_TOO_LOW);
  }

  if (
    Math.abs(timestamp(driverCurrent) - timestamp(passengerCurrent)) >
    config.maximumTimestampDifferenceMs
  ) {
    return finish('REJECT', BoardingRejectionReason.TIMESTAMPS_TOO_FAR_APART);
  }

  pickupRadius = clamp(
    config.minimumRadiusMeters,
    driverCurrent.accuracyMeters +
      passengerCurrent.accuracyMeters +
      config.safetyMarginMeters,
    config.maximumRadiusMeters,
  );
  metrics.pickupRadius = pickupRadius;
  metrics.distanceBetweenUsers = calculateBoardingDistanceMeters(
    driverCurrent,
    passengerCurrent,
  );

  if (
    candidate &&
    nowMs - new Date(candidate.createdAt).getTime() >
      config.candidateExpirationMs
  ) {
    previousState = candidate.state;
    candidate = {
      ...candidate,
      state: BoardingDetectionState.BOARDING_CANDIDATE_EXPIRED,
      previousState,
      updatedAt: now.toISOString(),
    };
    return finish(
      'REJECT',
      BoardingRejectionReason.SHARED_MOVEMENT_TOO_SHORT,
      candidate,
    );
  }

  if (
    !candidate ||
    candidate.state === BoardingDetectionState.BOARDING_REJECTED ||
    candidate.state === BoardingDetectionState.BOARDING_CANDIDATE_EXPIRED
  ) {
    const driverDistanceToPickup = input.pickupLocation
      ? calculateBoardingDistanceMeters(driverCurrent, input.pickupLocation)
      : Number.POSITIVE_INFINITY;
    const passengerDistanceToPickup = input.pickupLocation
      ? calculateBoardingDistanceMeters(passengerCurrent, input.pickupLocation)
      : Number.POSITIVE_INFINITY;
    if (
      metrics.distanceBetweenUsers > pickupRadius ||
      driverDistanceToPickup > pickupRadius ||
      passengerDistanceToPickup > pickupRadius
    ) {
      return finish('OBSERVE', BoardingRejectionReason.NOT_CLOSE_ENOUGH, null);
    }

    candidate = {
      state: BoardingDetectionState.BOARDING_CANDIDATE,
      previousState: BoardingDetectionState.DRIVER_APPROACHING,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      initialDriverLocation: driverCurrent,
      initialPassengerLocation: passengerCurrent,
      sharedMovementStartedAt: null,
      separationStartedAt: null,
      confirmedAt: null,
    };
    currentState = candidate.state;
    previousState = candidate.previousState;
    metrics.confidenceScore = 25;
    return finish(
      'OBSERVE',
      BoardingRejectionReason.NOT_ENOUGH_DRIVER_MOVEMENT,
      candidate,
    );
  }

  if (candidate.state === BoardingDetectionState.BOARDING_CONFIRMED) {
    return finish('OBSERVE', null, candidate);
  }

  const driverWindow = withCandidateAnchor(
    driverLocations,
    candidate.initialDriverLocation,
    config.windowSize,
  );
  const passengerWindow = withCandidateAnchor(
    passengerLocations,
    candidate.initialPassengerLocation,
    config.windowSize,
  );
  const pairs = pairSamples(
    driverWindow,
    passengerWindow,
    config.maximumTimestampDifferenceMs,
  );
  metrics.validSamples = pairs.length;

  if (
    hasImpossibleJump(
      driverWindow,
      config.maximumPlausibleSpeedMetersPerSecond,
    ) ||
    hasImpossibleJump(
      passengerWindow,
      config.maximumPlausibleSpeedMetersPerSecond,
    )
  ) {
    candidate = {
      ...candidate,
      state: BoardingDetectionState.BOARDING_REJECTED,
      previousState: candidate.state,
      updatedAt: now.toISOString(),
    };
    return finish(
      'REJECT',
      BoardingRejectionReason.IMPOSSIBLE_GPS_JUMP,
      candidate,
    );
  }

  const currentClose = metrics.distanceBetweenUsers <= pickupRadius;
  if (!currentClose) {
    const separationStartedAt =
      candidate.separationStartedAt ?? now.toISOString();
    const separationDuration = nowMs - new Date(separationStartedAt).getTime();
    candidate = {
      ...candidate,
      separationStartedAt,
      updatedAt: now.toISOString(),
    };
    if (separationDuration >= config.maximumContinuousSeparationDurationMs) {
      candidate = {
        ...candidate,
        state: BoardingDetectionState.BOARDING_REJECTED,
        previousState: candidate.state,
      };
      return finish(
        'REJECT',
        BoardingRejectionReason.PROXIMITY_NOT_STABLE,
        candidate,
      );
    }
  } else if (candidate.separationStartedAt) {
    candidate = {
      ...candidate,
      separationStartedAt: null,
      updatedAt: now.toISOString(),
    };
  }

  metrics.closeSamplesRatio =
    pairs.length > 0
      ? pairs.filter((pair) => pair.distanceMeters <= pickupRadius).length /
        pairs.length
      : 0;
  metrics.driverDistanceMoved = calculateBoardingDistanceMeters(
    candidate.initialDriverLocation,
    driverCurrent,
  );
  metrics.passengerDistanceMoved = calculateBoardingDistanceMeters(
    candidate.initialPassengerLocation,
    passengerCurrent,
  );
  metrics.sharedDistance = Math.min(
    pathDistance(driverWindow),
    pathDistance(passengerWindow),
  );
  metrics.driverSpeed = derivedSpeedKmh(driverWindow);
  metrics.passengerSpeed = derivedSpeedKmh(passengerWindow);
  metrics.speedDifference =
    metrics.driverSpeed !== null && metrics.passengerSpeed !== null
      ? Math.abs(metrics.driverSpeed - metrics.passengerSpeed)
      : null;
  metrics.driverHeading = weightedBearing(driverWindow);
  metrics.passengerHeading = weightedBearing(passengerWindow);
  metrics.headingDifference =
    metrics.driverHeading !== null && metrics.passengerHeading !== null
      ? angleDifference(metrics.driverHeading, metrics.passengerHeading)
      : null;

  const driverMovementStartedAt = firstMovementTimestamp(
    driverWindow,
    candidate.initialDriverLocation,
    5,
  );
  const passengerMovementStartedAt = firstMovementTimestamp(
    passengerWindow,
    candidate.initialPassengerLocation,
    5,
  );
  const departureCompatible = Boolean(
    driverMovementStartedAt &&
      passengerMovementStartedAt &&
      Math.abs(
        new Date(driverMovementStartedAt).getTime() -
          new Date(passengerMovementStartedAt).getTime(),
      ) <= config.maximumTimestampDifferenceMs,
  );
  const significantDriverMovement =
    metrics.driverDistanceMoved >= config.driverMinimumMovementMeters;
  const significantPassengerMovement =
    metrics.passengerDistanceMoved >= config.passengerMinimumMovementMeters;

  if (
    significantDriverMovement &&
    significantPassengerMovement &&
    !candidate.sharedMovementStartedAt
  ) {
    const thresholdPair = pairs.find(
      (pair) =>
        calculateBoardingDistanceMeters(
          candidate!.initialDriverLocation,
          pair.driver,
        ) >= config.driverMinimumMovementMeters &&
        calculateBoardingDistanceMeters(
          candidate!.initialPassengerLocation,
          pair.passenger,
        ) >= config.passengerMinimumMovementMeters,
    );
    candidate = {
      ...candidate,
      sharedMovementStartedAt:
        thresholdPair?.driver.recordedAt ?? now.toISOString(),
    };
  }

  metrics.sharedMovementDuration = candidate.sharedMovementStartedAt
    ? Math.max(0, nowMs - new Date(candidate.sharedMovementStartedAt).getTime())
    : 0;

  const proximityStable =
    pairs.length >= config.minimumValidSamples &&
    metrics.closeSamplesRatio >= config.minimumCloseSamplesRatio;
  const directionCompatible =
    metrics.headingDifference !== null &&
    metrics.headingDifference <= config.maximumHeadingDifferenceDegrees;
  const speedCompatible =
    metrics.speedDifference !== null &&
    metrics.speedDifference <= config.maximumSpeedDifferenceKmh;
  const slowTrafficPath = Boolean(
    significantDriverMovement &&
      significantPassengerMovement &&
      metrics.driverSpeed !== null &&
      metrics.passengerSpeed !== null &&
      Math.max(metrics.driverSpeed, metrics.passengerSpeed) <=
        config.slowTrafficMaximumSpeedKmh &&
      nowMs - new Date(candidate.createdAt).getTime() >=
        config.slowTrafficObservationDurationMs &&
      metrics.sharedDistance >= config.slowTrafficMinimumSharedDistanceMeters &&
      synchronizedMovementRatio(pairs) >= config.minimumCloseSamplesRatio &&
      proximityStable &&
      speedCompatible &&
      !candidate.separationStartedAt,
  );
  metrics.slowTrafficPath = slowTrafficPath;

  let score = 10;
  score += 15;
  const initialDriverSpeed =
    candidate.initialDriverLocation.speedMetersPerSecond;
  if (initialDriverSpeed !== null && initialDriverSpeed <= 2) score += 10;
  if (departureCompatible) score += 15;
  if (significantDriverMovement && significantPassengerMovement) score += 15;
  if (directionCompatible || slowTrafficPath) score += 10;
  if (speedCompatible) score += 10;
  if (proximityStable) score += 10;
  if (
    slowTrafficPath ||
    (metrics.sharedMovementDuration >= config.minimumSharedMovementDurationMs &&
      metrics.sharedDistance >= config.minimumSharedDistanceMeters)
  ) {
    score += 15;
  }
  metrics.confidenceScore = Math.min(100, score);

  if (significantDriverMovement && significantPassengerMovement) {
    candidate = {
      ...candidate,
      state: BoardingDetectionState.SHARED_MOVEMENT_DETECTED,
      previousState: candidate.state,
      updatedAt: now.toISOString(),
    };
  }

  const normalPath = Boolean(
    significantDriverMovement &&
      significantPassengerMovement &&
      departureCompatible &&
      directionCompatible &&
      speedCompatible &&
      proximityStable &&
      metrics.sharedMovementDuration >=
        config.minimumSharedMovementDurationMs &&
      metrics.sharedDistance >= config.minimumSharedDistanceMeters &&
      !candidate.separationStartedAt,
  );

  if (
    (normalPath || slowTrafficPath) &&
    metrics.confidenceScore >= config.confirmationScore
  ) {
    candidate = {
      ...candidate,
      state: BoardingDetectionState.BOARDING_CONFIRMED,
      previousState: candidate.state,
      confirmedAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    return finish('CONFIRM', null, candidate);
  }

  let rejectionReason: BoardingRejectionReason;
  if (!significantDriverMovement) {
    rejectionReason = BoardingRejectionReason.NOT_ENOUGH_DRIVER_MOVEMENT;
  } else if (!significantPassengerMovement) {
    rejectionReason =
      nowMs - new Date(candidate.createdAt).getTime() >=
      config.minimumSharedMovementDurationMs
        ? BoardingRejectionReason.PASSENGER_LOCATION_INACTIVE
        : BoardingRejectionReason.NOT_ENOUGH_PASSENGER_MOVEMENT;
  } else if (!proximityStable) {
    rejectionReason = BoardingRejectionReason.PROXIMITY_NOT_STABLE;
  } else if (!speedCompatible) {
    rejectionReason = BoardingRejectionReason.SPEED_MISMATCH;
  } else if (metrics.headingDifference === null && !slowTrafficPath) {
    rejectionReason = BoardingRejectionReason.DIRECTION_UNAVAILABLE;
  } else if (!directionCompatible && !slowTrafficPath) {
    rejectionReason = BoardingRejectionReason.DIRECTION_MISMATCH;
  } else if (
    metrics.sharedMovementDuration < config.minimumSharedMovementDurationMs &&
    !slowTrafficPath
  ) {
    rejectionReason = BoardingRejectionReason.SHARED_MOVEMENT_TOO_SHORT;
  } else {
    rejectionReason = BoardingRejectionReason.SHARED_DISTANCE_TOO_SHORT;
  }

  return finish('OBSERVE', rejectionReason, candidate);
}
