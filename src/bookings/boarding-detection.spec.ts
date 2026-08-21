import {
  BoardingCandidateSnapshot,
  BoardingDetectionState,
  BoardingLocationSample,
  BoardingRejectionReason,
  angleDifference,
  evaluateBoardingDetection,
} from './boarding-detection';
import {
  BoardingDetectionConfig,
  DEFAULT_BOARDING_DETECTION_CONFIG,
} from './boarding-detection.config';

describe('boarding detection', () => {
  const now = new Date('2026-08-06T12:00:00.000Z');
  const origin = { latitude: -4.3, longitude: 15.3 };

  const coordinateAt = (forwardMeters: number, lateralMeters = 0) => ({
    latitude: origin.latitude + lateralMeters / 111_000,
    longitude:
      origin.longitude +
      forwardMeters / (111_000 * Math.cos((origin.latitude * Math.PI) / 180)),
  });

  const makePath = ({
    distanceMeters = 100,
    durationSeconds = 30,
    lateralMeters = 0,
    accuracyMeters = 5,
    count = 10,
    startDelaySeconds = 0,
  }: {
    distanceMeters?: number;
    durationSeconds?: number;
    lateralMeters?: number;
    accuracyMeters?: number;
    count?: number;
    startDelaySeconds?: number;
  } = {}): BoardingLocationSample[] =>
    Array.from({ length: count }, (_, index) => {
      const ratio = index / (count - 1);
      const elapsedSeconds = durationSeconds * ratio;
      const coordinate = coordinateAt(distanceMeters * ratio, lateralMeters);
      return {
        ...coordinate,
        recordedAt: new Date(
          now.getTime() -
            durationSeconds * 1_000 +
            elapsedSeconds * 1_000 +
            startDelaySeconds * 1_000,
        ).toISOString(),
        accuracyMeters,
        speedMetersPerSecond:
          index === 0 ? 0 : distanceMeters / durationSeconds,
        headingDegrees: 90,
      };
    });

  const makeCandidate = (
    driverLocations: BoardingLocationSample[],
    passengerLocations: BoardingLocationSample[],
    overrides: Partial<BoardingCandidateSnapshot> = {},
  ): BoardingCandidateSnapshot => ({
    state: BoardingDetectionState.BOARDING_CANDIDATE,
    previousState: BoardingDetectionState.DRIVER_APPROACHING,
    createdAt: driverLocations[0].recordedAt,
    updatedAt: driverLocations[0].recordedAt,
    initialDriverLocation: driverLocations[0],
    initialPassengerLocation: passengerLocations[0],
    sharedMovementStartedAt: null,
    separationStartedAt: null,
    confirmedAt: null,
    ...overrides,
  });

  const evaluate = ({
    driverLocations = makePath(),
    passengerLocations = makePath({ lateralMeters: 2 }),
    candidate,
    stateCompatible = true,
    config = DEFAULT_BOARDING_DETECTION_CONFIG,
  }: {
    driverLocations?: BoardingLocationSample[];
    passengerLocations?: BoardingLocationSample[];
    candidate?: BoardingCandidateSnapshot | null;
    stateCompatible?: boolean;
    config?: BoardingDetectionConfig;
  } = {}) =>
    evaluateBoardingDetection({
      now,
      stateCompatible,
      pickupLocation: origin,
      driverLocations,
      passengerLocations,
      candidate:
        candidate === undefined
          ? makeCandidate(driverLocations, passengerLocations)
          : candidate,
      config,
    });

  const expectConfirmed = (result: ReturnType<typeof evaluate>) => {
    expect(result.decision).toBe('CONFIRM');
    expect(result.rejectionReason).toBeNull();
    expect(result.candidate?.state).toBe(
      BoardingDetectionState.BOARDING_CONFIRMED,
    );
    expect(result.metrics.confidenceScore).toBeGreaterThanOrEqual(80);
  };

  const expectRejected = (
    result: ReturnType<typeof evaluate>,
    reason: BoardingRejectionReason,
  ) => {
    expect(result.decision).not.toBe('CONFIRM');
    expect(result.rejectionReason).toBe(reason);
    expect(result.metrics.confidenceScore).toBeLessThanOrEqual(100);
  };

  it('confirms when driver and passenger were already close at tracking start', () => {
    const driverLocations = makePath();
    const passengerLocations = makePath({ lateralMeters: 2 });
    const firstEvaluation = evaluateBoardingDetection({
      now: new Date(driverLocations[0].recordedAt),
      stateCompatible: true,
      pickupLocation: origin,
      driverLocations: [driverLocations[0]],
      passengerLocations: [passengerLocations[0]],
      candidate: null,
      config: DEFAULT_BOARDING_DETECTION_CONFIG,
    });

    expect(firstEvaluation.candidate?.state).toBe(
      BoardingDetectionState.BOARDING_CANDIDATE,
    );
    expectConfirmed(
      evaluate({
        driverLocations,
        passengerLocations,
        candidate: firstEvaluation.candidate,
      }),
    );
  });

  it('creates a candidate and confirms after the driver arrives later', () => {
    const driverLocations = makePath();
    const passengerLocations = makePath({ lateralMeters: 2 });
    const farDriver = {
      ...driverLocations[0],
      ...coordinateAt(0, 100),
    };
    expectRejected(
      evaluateBoardingDetection({
        now: new Date(driverLocations[0].recordedAt),
        stateCompatible: true,
        pickupLocation: origin,
        driverLocations: [farDriver],
        passengerLocations: [passengerLocations[0]],
        candidate: null,
        config: DEFAULT_BOARDING_DETECTION_CONFIG,
      }),
      BoardingRejectionReason.NOT_CLOSE_ENOUGH,
    );

    const arrived = evaluateBoardingDetection({
      now: new Date(driverLocations[0].recordedAt),
      stateCompatible: true,
      pickupLocation: origin,
      driverLocations: [driverLocations[0]],
      passengerLocations: [passengerLocations[0]],
      candidate: null,
      config: DEFAULT_BOARDING_DETECTION_CONFIG,
    });
    expect(arrived.candidate?.state).toBe(
      BoardingDetectionState.BOARDING_CANDIDATE,
    );
    expectConfirmed(
      evaluate({
        driverLocations,
        passengerLocations,
        candidate: arrived.candidate,
      }),
    );
  });

  it('creates an in-trip recovery candidate when both devices reappear together away from pickup', () => {
    const driverLocations = makePath().map((sample, index, samples) => ({
      ...sample,
      ...coordinateAt(500 + (100 * index) / (samples.length - 1)),
    }));
    const passengerLocations = makePath({ lateralMeters: 2 }).map(
      (sample, index, samples) => ({
        ...sample,
        ...coordinateAt(500 + (100 * index) / (samples.length - 1), 2),
      }),
    );

    const blockedWithoutRecovery = evaluateBoardingDetection({
      now: new Date(driverLocations[0].recordedAt),
      stateCompatible: true,
      pickupLocation: origin,
      driverLocations: [driverLocations[0]],
      passengerLocations: [passengerLocations[0]],
      candidate: null,
      config: DEFAULT_BOARDING_DETECTION_CONFIG,
    });
    expect(blockedWithoutRecovery.candidate).toBeNull();

    const firstRecoveryEvaluation = evaluateBoardingDetection({
      now: new Date(driverLocations[0].recordedAt),
      stateCompatible: true,
      pickupLocation: origin,
      driverLocations: [driverLocations[0]],
      passengerLocations: [passengerLocations[0]],
      candidate: null,
      allowCandidateAwayFromPickup: true,
      config: DEFAULT_BOARDING_DETECTION_CONFIG,
    });
    expect(firstRecoveryEvaluation.candidate).toEqual(
      expect.objectContaining({
        state: BoardingDetectionState.BOARDING_CANDIDATE,
        origin: 'in_trip_recovery',
      }),
    );

    const confirmed = evaluateBoardingDetection({
      now,
      stateCompatible: true,
      pickupLocation: origin,
      driverLocations,
      passengerLocations,
      candidate: firstRecoveryEvaluation.candidate,
      allowCandidateAwayFromPickup: true,
      config: DEFAULT_BOARDING_DETECTION_CONFIG,
    });
    expectConfirmed(confirmed);
  });

  it('scores a stopped driver followed by a synchronized departure', () => {
    const result = evaluate();
    expectConfirmed(result);
    expect(result.metrics.driverDistanceMoved).toBeGreaterThan(90);
    expect(result.metrics.passengerDistanceMoved).toBeGreaterThan(90);
  });

  it('confirms normal movement with comparable speed and direction', () => {
    const result = evaluate();
    expectConfirmed(result);
    expect(result.metrics.headingDifference).toBeLessThan(1);
    expect(result.metrics.speedDifference).toBeLessThan(1);
  });

  it('confirms when driver and passenger samples use different 3s and 8s cadences', () => {
    const makeCadencedPath = (
      intervalSeconds: number,
      lateralMeters: number,
    ): BoardingLocationSample[] =>
      Array.from(
        { length: Math.floor(60 / intervalSeconds) + 1 },
        (_, index) => {
          const elapsedSeconds = index * intervalSeconds;
          return {
            ...coordinateAt((100 * elapsedSeconds) / 60, lateralMeters),
            recordedAt: new Date(
              now.getTime() - 60_000 + elapsedSeconds * 1_000,
            ).toISOString(),
            accuracyMeters: 5,
            speedMetersPerSecond: 100 / 60,
            headingDegrees: 90,
          };
        },
      );
    const driverLocations = makeCadencedPath(3, 0);
    const passengerLocations = makeCadencedPath(8, 2);

    const result = evaluate({
      driverLocations,
      passengerLocations,
      candidate: makeCandidate(driverLocations, passengerLocations),
    });

    expectConfirmed(result);
    expect(result.metrics.validSamples).toBeGreaterThanOrEqual(7);
  });

  it('compares headings circularly across north', () => {
    expect(angleDifference(359, 1)).toBe(2);
    expect(angleDifference(1, 359)).toBe(2);
  });

  it('confirms slow traffic from durable synchronized movement without relying on heading', () => {
    const driverLocations = makePath({
      distanceMeters: 50,
      durationSeconds: 70,
    });
    const passengerLocations = makePath({
      distanceMeters: 50,
      durationSeconds: 70,
      lateralMeters: 2,
    });
    const result = evaluate({ driverLocations, passengerLocations });
    expectConfirmed(result);
    expect(result.metrics.slowTrafficPath).toBe(true);
  });

  it.each([
    'reconnexion Socket.IO',
    'retour au premier plan',
    'restauration apres redemarrage',
  ])('restores and confirms the persisted candidate after %s', () => {
    const result = evaluate();
    expectConfirmed(result);
    expect(result.metrics.previousState).toBe(
      BoardingDetectionState.SHARED_MOVEMENT_DETECTED,
    );
  });

  it('accepts moderate GPS uncertainty through the dynamic radius', () => {
    const driverLocations = makePath({ accuracyMeters: 20 });
    const passengerLocations = makePath({
      lateralMeters: 35,
      accuracyMeters: 20,
    });
    const result = evaluate({ driverLocations, passengerLocations });
    expectConfirmed(result);
    expect(result.metrics.pickupRadius).toBe(50);
  });

  it('does not confirm a driver merely passing near the passenger', () => {
    const driverLocations = makePath({ durationSeconds: 8 });
    const passengerLocations = makePath({
      distanceMeters: 0,
      durationSeconds: 8,
      lateralMeters: 2,
    });
    const result = evaluate({ driverLocations, passengerLocations });
    expect(result.decision).not.toBe('CONFIRM');
    expect([
      BoardingRejectionReason.NOT_ENOUGH_PASSENGER_MOVEMENT,
      BoardingRejectionReason.PASSENGER_LOCATION_INACTIVE,
      BoardingRejectionReason.PROXIMITY_NOT_STABLE,
    ]).toContain(result.rejectionReason);
  });

  it('does not confirm a passenger walking while the driver leaves', () => {
    const driverLocations = makePath({ distanceMeters: 120 });
    const passengerLocations = makePath({
      distanceMeters: 30,
      lateralMeters: 2,
    });
    const result = evaluate({ driverLocations, passengerLocations });
    expect(result.decision).not.toBe('CONFIRM');
    expect([
      BoardingRejectionReason.PROXIMITY_NOT_STABLE,
      BoardingRejectionReason.NOT_CLOSE_ENOUGH,
    ]).toContain(result.rejectionReason);
  });

  it('does not confirm users on parallel roads outside the dynamic radius', () => {
    const driverLocations = makePath();
    const passengerLocations = makePath({ lateralMeters: 35 });
    expectRejected(
      evaluate({ driverLocations, passengerLocations }),
      BoardingRejectionReason.PROXIMITY_NOT_STABLE,
    );
  });

  it('rejects when the driver leaves without the passenger', () => {
    const driverLocations = makePath();
    const passengerLocations = makePath({
      distanceMeters: 0,
      lateralMeters: 2,
    });
    expectRejected(
      evaluate({ driverLocations, passengerLocations }),
      BoardingRejectionReason.PASSENGER_LOCATION_INACTIVE,
    );
  });

  it('does not confirm when distance increases continuously', () => {
    const driverLocations = makePath({ distanceMeters: 100 });
    const passengerLocations = makePath({
      distanceMeters: 55,
      lateralMeters: 2,
    });
    const result = evaluate({ driverLocations, passengerLocations });
    expect(result.decision).not.toBe('CONFIRM');
    expect(result.metrics.closeSamplesRatio).toBeLessThan(1);
  });

  it('rejects a candidate after more than ten continuous seconds of separation', () => {
    const driverLocations = makePath({ distanceMeters: 100 });
    const passengerLocations = makePath({
      distanceMeters: 55,
      lateralMeters: 2,
    });
    const candidate = makeCandidate(driverLocations, passengerLocations, {
      separationStartedAt: new Date(now.getTime() - 11_000).toISOString(),
    });

    expectRejected(
      evaluate({ driverLocations, passengerLocations, candidate }),
      BoardingRejectionReason.PROXIMITY_NOT_STABLE,
    );
  });

  it('never confirms proximity alone while both users remain stationary', () => {
    const driverLocations = makePath({ distanceMeters: 0 });
    const passengerLocations = makePath({
      distanceMeters: 0,
      lateralMeters: 2,
    });
    expectRejected(
      evaluate({ driverLocations, passengerLocations }),
      BoardingRejectionReason.NOT_ENOUGH_DRIVER_MOVEMENT,
    );
  });

  it('rejects stale positions', () => {
    const driverLocations = makePath().map((sample) => ({
      ...sample,
      recordedAt: new Date(
        new Date(sample.recordedAt).getTime() - 11_000,
      ).toISOString(),
    }));
    const passengerLocations = makePath({ lateralMeters: 2 }).map((sample) => ({
      ...sample,
      recordedAt: new Date(
        new Date(sample.recordedAt).getTime() - 11_000,
      ).toISOString(),
    }));
    expectRejected(
      evaluate({ driverLocations, passengerLocations }),
      BoardingRejectionReason.LOCATION_STALE,
    );
  });

  it('rejects strongly desynchronized positions', () => {
    const passengerLocations = makePath({
      lateralMeters: 2,
      startDelaySeconds: 6,
    });
    expectRejected(
      evaluate({ passengerLocations }),
      BoardingRejectionReason.TIMESTAMPS_TOO_FAR_APART,
    );
  });

  it('rejects unusable GPS accuracy', () => {
    const passengerLocations = makePath({
      lateralMeters: 2,
      accuracyMeters: 71,
    });
    expectRejected(
      evaluate({ passengerLocations }),
      BoardingRejectionReason.GPS_ACCURACY_TOO_LOW,
    );
  });

  it('rejects identical headings when derived speeds are incompatible', () => {
    const config = {
      ...DEFAULT_BOARDING_DETECTION_CONFIG,
      maximumRadiusMeters: 60,
      minimumValidSamples: 7,
      minimumSharedMovementDurationMs: 0,
      minimumSharedDistanceMeters: 50,
    };
    const driverLocations = makePath({
      distanceMeters: 100,
      durationSeconds: 10,
      accuracyMeters: 25,
    });
    const passengerLocations = makePath({
      distanceMeters: 60,
      durationSeconds: 10,
      lateralMeters: 2,
      accuracyMeters: 25,
    });
    expectRejected(
      evaluate({ driverLocations, passengerLocations, config }),
      BoardingRejectionReason.SPEED_MISMATCH,
    );
  });

  it('keeps candidates independent when several passengers wait at one point', () => {
    const movingPassenger = evaluate();
    const stationaryPassengerLocations = makePath({
      distanceMeters: 0,
      lateralMeters: 3,
    });
    const stationaryPassenger = evaluate({
      passengerLocations: stationaryPassengerLocations,
    });

    expectConfirmed(movingPassenger);
    expectRejected(
      stationaryPassenger,
      BoardingRejectionReason.PASSENGER_LOCATION_INACTIVE,
    );
  });

  it('rejects an inactive or frozen passenger location', () => {
    const passengerLocations = makePath({
      distanceMeters: 0,
      lateralMeters: 2,
    });
    expectRejected(
      evaluate({ passengerLocations }),
      BoardingRejectionReason.PASSENGER_LOCATION_INACTIVE,
    );
  });

  it('rejects an impossible GPS jump', () => {
    const driverLocations = makePath({
      distanceMeters: 10_000,
      durationSeconds: 5,
    });
    const passengerLocations = makePath({
      distanceMeters: 10_000,
      durationSeconds: 5,
      lateralMeters: 2,
    });
    expectRejected(
      evaluate({ driverLocations, passengerLocations }),
      BoardingRejectionReason.IMPOSSIBLE_GPS_JUMP,
    );
  });

  it('rejects an incompatible trip or booking state', () => {
    expectRejected(
      evaluate({ stateCompatible: false }),
      BoardingRejectionReason.INVALID_STATE_TRANSITION,
    );
  });
});
