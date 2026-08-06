import { TrackingGateway } from './tracking.gateway';

describe('TrackingGateway boarding detection recovery', () => {
  const createClient = () =>
    ({
      data: { userId: 'passenger-1' },
      join: jest.fn(),
      leave: jest.fn(),
      emit: jest.fn(),
    }) as any;

  let tripsService: {
    ensureUserCanTrackTrip: jest.Mock;
    updateDriverLocation: jest.Mock;
  };
  let bookingsService: {
    evaluateAutomaticRideProgressForTrip: jest.Mock;
    updatePassengerLocation: jest.Mock;
  };
  let gateway: TrackingGateway;

  beforeEach(() => {
    tripsService = {
      ensureUserCanTrackTrip: jest.fn().mockResolvedValue(undefined),
      updateDriverLocation: jest.fn(),
    };
    bookingsService = {
      evaluateAutomaticRideProgressForTrip: jest.fn().mockResolvedValue({
        tripId: 'trip-1',
        events: [],
      }),
      updatePassengerLocation: jest.fn(),
    };
    gateway = new TrackingGateway(
      tripsService as any,
      bookingsService as any,
      {} as any,
      {} as any,
    );
  });

  it('restores and evaluates the candidate whenever a user joins or reconnects to a trip', async () => {
    const client = createClient();
    const progress = {
      tripId: 'trip-1',
      events: [
        {
          type: 'pickup_confirmed',
          bookingId: 'booking-1',
          boardingState: 'BOARDING_CONFIRMED',
        },
      ],
    };
    bookingsService.evaluateAutomaticRideProgressForTrip.mockResolvedValue(
      progress,
    );

    await gateway.handleJoinTrip(client, { tripId: 'trip-1' });

    expect(tripsService.ensureUserCanTrackTrip).toHaveBeenCalledWith(
      'trip-1',
      'passenger-1',
    );
    expect(client.join).toHaveBeenCalledWith('trip:trip-1');
    expect(
      bookingsService.evaluateAutomaticRideProgressForTrip,
    ).toHaveBeenCalledWith('trip-1');
    expect(client.emit).toHaveBeenCalledWith('booking_auto_progress', progress);
  });

  it('re-evaluates explicitly on foreground resume without emitting an empty duplicate event', async () => {
    const client = createClient();

    await gateway.handleResumeBoardingDetection(client, { tripId: 'trip-1' });

    expect(tripsService.ensureUserCanTrackTrip).toHaveBeenCalledWith(
      'trip-1',
      'passenger-1',
    );
    expect(
      bookingsService.evaluateAutomaticRideProgressForTrip,
    ).toHaveBeenCalledWith('trip-1');
    expect(client.emit).not.toHaveBeenCalledWith(
      'booking_auto_progress',
      expect.anything(),
    );
  });

  it('forwards GPS quality and device timestamps from Socket.IO to the backend authority', async () => {
    const client = createClient();
    const roomEmit = jest.fn();
    (gateway as any).server = {
      to: jest.fn(() => ({ emit: roomEmit })),
    };
    tripsService.updateDriverLocation.mockResolvedValue({
      tripId: 'trip-1',
      coordinates: [15.3, -4.3],
    });

    await gateway.handleDriverLocationUpdate(client, {
      tripId: 'trip-1',
      coordinates: [15.3, -4.3],
      accuracy: 7,
      speed: 4.2,
      heading: 91,
      recordedAt: '2026-08-06T12:00:00.000Z',
    });

    expect(tripsService.updateDriverLocation).toHaveBeenCalledWith(
      'passenger-1',
      'trip-1',
      [15.3, -4.3],
      {
        accuracyMeters: 7,
        speedMetersPerSecond: 4.2,
        headingDegrees: 91,
        recordedAt: '2026-08-06T12:00:00.000Z',
      },
    );
  });
});
