import { BadRequestException } from '@nestjs/common';
import { TripsService } from './trips.service';
import { UserRole } from '../users/entities/user.entity';
import { TripStatus } from './entities/trip.entity';
import { BookingStatus } from '../bookings/entities/booking.entity';

describe('TripsService daily trip publication quota', () => {
  let service: any;
  let tripRepository: {
    create: jest.Mock;
    save: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let userRepository: { findOne: jest.Mock; save: jest.Mock };
  let subscriptionsService: { getPremiumOverview: jest.Mock };
  let cacheService: { del: jest.Mock };

  const baseCreateTripDto = {
    departureLocation: 'Gombe',
    departureCoordinates: [15.2663, -4.325] as [number, number],
    arrivalLocation: 'Limete',
    arrivalCoordinates: [15.3222, -4.4419] as [number, number],
    departureDate: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    totalSeats: 3,
    pricePerSeat: 1000,
  };

  beforeEach(() => {
    tripRepository = {
      create: jest.fn((payload) => payload),
      save: jest.fn().mockResolvedValue({ id: 'trip-1' }),
      createQueryBuilder: jest.fn(),
    };
    userRepository = {
      findOne: jest.fn().mockResolvedValue({
        id: 'driver-1',
        role: UserRole.DRIVER,
        isDriver: true,
      }),
      save: jest.fn(),
    };
    subscriptionsService = {
      getPremiumOverview: jest.fn(),
    };
    cacheService = {
      del: jest.fn().mockResolvedValue(undefined),
    };

    service = new TripsService(
      tripRepository as any,
      {} as any,
      {} as any,
      userRepository as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      cacheService as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      subscriptionsService as any,
      {} as any,
      { recordDriverLocation: jest.fn().mockResolvedValue(undefined) } as any,
      {} as any,
    );

    jest.spyOn(service, 'findOne').mockResolvedValue({ id: 'trip-1' });
  });

  function mockPublishedTodayCount(count: number) {
    const queryBuilder = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getCount: jest.fn().mockResolvedValue(count),
    };

    tripRepository.createQueryBuilder.mockReturnValue(queryBuilder);
    return queryBuilder;
  }

  it('blocks a non-subscribed driver after five trips in the current day', async () => {
    subscriptionsService.getPremiumOverview.mockResolvedValue({
      isActive: false,
    });
    mockPublishedTodayCount(5);

    await expect(
      service.create('driver-1', baseCreateTripDto),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(tripRepository.save).not.toHaveBeenCalled();
  });

  it('does not apply the free daily quota to subscribed drivers', async () => {
    subscriptionsService.getPremiumOverview.mockResolvedValue({
      isActive: true,
    });

    await expect(
      service.create('driver-1', baseCreateTripDto),
    ).resolves.toEqual({ id: 'trip-1' });

    expect(tripRepository.createQueryBuilder).not.toHaveBeenCalled();
    expect(tripRepository.save).toHaveBeenCalledTimes(1);
  });

  it('caps recurring trip batches to the remaining free daily quota', async () => {
    subscriptionsService.getPremiumOverview.mockResolvedValue({
      isActive: false,
    });
    mockPublishedTodayCount(3);

    const tripsToCreate = [{ id: '1' }, { id: '2' }, { id: '3' }];
    const result = await service.applyDailyTripPublicationQuota(
      'driver-1',
      tripsToCreate,
    );

    expect(result).toEqual([{ id: '1' }, { id: '2' }]);
  });
});

describe('TripsService trip deletion rules', () => {
  let service: any;
  let tripRepository: {
    findOne: jest.Mock;
    save: jest.Mock;
    remove: jest.Mock;
  };
  let bookingRepository: { update: jest.Mock; delete: jest.Mock };
  let cacheService: { del: jest.Mock };

  beforeEach(() => {
    tripRepository = {
      findOne: jest.fn(),
      save: jest.fn().mockImplementation(async (trip) => trip),
      remove: jest.fn().mockResolvedValue(undefined),
    };
    bookingRepository = {
      update: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue(undefined),
    };
    cacheService = {
      del: jest.fn().mockResolvedValue(undefined),
    };

    service = new TripsService(
      tripRepository as any,
      {} as any,
      bookingRepository as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      cacheService as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { recordDriverLocation: jest.fn().mockResolvedValue(undefined) } as any,
      {} as any,
    );
  });

  it('allows deleting a non-terminal trip when there is no accepted/in-progress booking', async () => {
    const trip = {
      id: 'trip-1',
      driverId: 'driver-1',
      status: TripStatus.ACTIVE,
      departureDate: new Date(Date.now() + 60 * 60 * 1000),
      bookings: [
        {
          id: 'booking-pending',
          status: BookingStatus.PENDING,
          pickedUp: false,
          pickedUpConfirmedByPassenger: false,
          droppedOff: false,
          droppedOffConfirmedByPassenger: false,
        },
      ],
    };

    tripRepository.findOne.mockResolvedValue(trip);

    await expect(service.remove('trip-1', 'driver-1')).resolves.toBeUndefined();
    expect(bookingRepository.update).toHaveBeenCalledWith(
      ['booking-pending'],
      expect.objectContaining({
        status: BookingStatus.CANCELLED,
        cancelledAt: expect.any(Date),
      }),
    );
    expect(bookingRepository.delete).toHaveBeenCalledWith({ tripId: 'trip-1' });
    expect(tripRepository.remove).toHaveBeenCalledWith(trip);
  });

  it('cancels an accepted booking without pickup and deletes the trip', async () => {
    const trip = {
      id: 'trip-2',
      driverId: 'driver-1',
      status: TripStatus.ACTIVE,
      departureDate: new Date(Date.now() + 60 * 60 * 1000),
      bookings: [
        {
          id: 'booking-accepted',
          status: BookingStatus.ACCEPTED,
          pickedUp: false,
          pickedUpConfirmedByPassenger: false,
          droppedOff: false,
          droppedOffConfirmedByPassenger: false,
        },
      ],
    };

    tripRepository.findOne.mockResolvedValue(trip);

    await expect(service.remove('trip-2', 'driver-1')).resolves.toBeUndefined();
    expect(bookingRepository.update).toHaveBeenCalledWith(
      ['booking-accepted'],
      expect.objectContaining({
        status: BookingStatus.CANCELLED,
        cancelledAt: expect.any(Date),
      }),
    );
    expect(bookingRepository.delete).toHaveBeenCalledWith({ tripId: 'trip-2' });
    expect(tripRepository.remove).toHaveBeenCalledWith(trip);
  });

  it('blocks deletion while a passenger is on board', async () => {
    const trip = {
      id: 'trip-3',
      driverId: 'driver-1',
      status: TripStatus.ACTIVE,
      departureDate: new Date(),
      bookings: [
        {
          id: 'booking-on-board',
          status: BookingStatus.ACCEPTED,
          pickedUp: true,
          pickedUpConfirmedByPassenger: false,
          droppedOff: false,
          droppedOffConfirmedByPassenger: false,
        },
      ],
    };

    tripRepository.findOne.mockResolvedValue(trip);

    await expect(service.remove('trip-3', 'driver-1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(bookingRepository.update).not.toHaveBeenCalled();
    expect(bookingRepository.delete).not.toHaveBeenCalled();
    expect(tripRepository.remove).not.toHaveBeenCalled();
  });

  it('allows deletion after the passenger has been dropped off', async () => {
    const trip = {
      id: 'trip-4',
      driverId: 'driver-1',
      status: TripStatus.ACTIVE,
      departureDate: new Date(),
      bookings: [
        {
          id: 'booking-dropped-off',
          status: BookingStatus.ACCEPTED,
          pickedUp: true,
          pickedUpConfirmedByPassenger: true,
          droppedOff: true,
          droppedOffConfirmedByPassenger: false,
        },
      ],
    };

    tripRepository.findOne.mockResolvedValue(trip);

    await expect(service.remove('trip-4', 'driver-1')).resolves.toBeUndefined();
    expect(bookingRepository.update).not.toHaveBeenCalled();
    expect(bookingRepository.delete).toHaveBeenCalledWith({ tripId: 'trip-4' });
    expect(tripRepository.remove).toHaveBeenCalledWith(trip);
  });

  it('allows deletion when dropoff is recorded only by its timestamp', async () => {
    const trip = {
      id: 'trip-dropoff-timestamp',
      driverId: 'driver-1',
      status: TripStatus.ACTIVE,
      departureDate: new Date(),
      bookings: [
        {
          id: 'booking-dropoff-timestamp',
          status: BookingStatus.ACCEPTED,
          pickedUp: true,
          pickedUpAt: new Date(Date.now() - 30 * 60 * 1000),
          pickedUpConfirmedByPassenger: true,
          droppedOff: false,
          droppedOffAt: new Date(),
          droppedOffConfirmedByPassenger: false,
        },
      ],
    };

    tripRepository.findOne.mockResolvedValue(trip);

    await expect(
      service.remove('trip-dropoff-timestamp', 'driver-1'),
    ).resolves.toBeUndefined();
    expect(bookingRepository.update).not.toHaveBeenCalled();
    expect(bookingRepository.delete).toHaveBeenCalledWith({
      tripId: 'trip-dropoff-timestamp',
    });
    expect(tripRepository.remove).toHaveBeenCalledWith(trip);
  });

  it('allows deletion for a completed booking with legacy dropoff flags', async () => {
    const trip = {
      id: 'trip-5',
      driverId: 'driver-1',
      status: TripStatus.COMPLETED,
      departureDate: new Date(),
      bookings: [
        {
          id: 'booking-completed',
          status: BookingStatus.COMPLETED,
          pickedUp: true,
          pickedUpConfirmedByPassenger: true,
          droppedOff: false,
          droppedOffConfirmedByPassenger: false,
        },
      ],
    };

    tripRepository.findOne.mockResolvedValue(trip);

    await expect(service.remove('trip-5', 'driver-1')).resolves.toBeUndefined();
    expect(bookingRepository.update).not.toHaveBeenCalled();
    expect(bookingRepository.delete).toHaveBeenCalledWith({ tripId: 'trip-5' });
    expect(tripRepository.remove).toHaveBeenCalledWith(trip);
  });

  it('blocks completion while an accepted passenger has not been dropped off', async () => {
    const trip = {
      id: 'trip-active',
      driverId: 'driver-1',
      status: TripStatus.ACTIVE,
      bookings: [
        {
          id: 'booking-active',
          status: BookingStatus.ACCEPTED,
          pickedUp: true,
          pickedUpConfirmedByPassenger: true,
          droppedOff: false,
          droppedOffConfirmedByPassenger: false,
        },
      ],
    };

    tripRepository.findOne.mockResolvedValue(trip);

    await expect(
      service.completeTrip('trip-active', 'driver-1'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(tripRepository.save).not.toHaveBeenCalled();
  });
});

describe('TripsService started trip ETA expiration', () => {
  let service: any;
  let tripRepository: {
    find: jest.Mock;
    findOne: jest.Mock;
    save: jest.Mock;
    update: jest.Mock;
    increment: jest.Mock;
  };
  let bookingRepository: { update: jest.Mock };
  let userRepository: { find: jest.Mock };
  let cacheService: { del: jest.Mock };
  let googleMapsService: { getDirections: jest.Mock };
  let weatherAwarenessService: { getRouteImpact: jest.Mock };

  const now = new Date('2026-05-20T12:00:00.000Z');

  beforeEach(() => {
    tripRepository = {
      find: jest.fn(),
      findOne: jest.fn(),
      save: jest.fn().mockImplementation(async (trip) => trip),
      update: jest.fn().mockResolvedValue(undefined),
      increment: jest.fn().mockResolvedValue(undefined),
    };
    bookingRepository = {
      update: jest.fn().mockResolvedValue(undefined),
    };
    userRepository = {
      find: jest.fn().mockResolvedValue([]),
    };
    cacheService = {
      del: jest.fn().mockResolvedValue(undefined),
    };
    googleMapsService = {
      getDirections: jest.fn().mockResolvedValue({
        routes: [
          {
            legs: [{ duration: 30 * 60 }],
          },
        ],
      }),
    };
    weatherAwarenessService = {
      getRouteImpact: jest.fn().mockResolvedValue({
        heavyRain: false,
        dataAvailable: true,
        priceMultiplier: 1,
        etaMultiplier: 1,
        evaluatedZoneIds: ['cd-kinshasa-gombe'],
        affectedZoneIds: [],
      }),
    };

    service = new TripsService(
      tripRepository as any,
      {} as any,
      bookingRepository as any,
      userRepository as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      cacheService as any,
      {} as any,
      {} as any,
      {} as any,
      googleMapsService as any,
      {} as any,
      weatherAwarenessService as any,
      { recordDriverLocation: jest.fn().mockResolvedValue(undefined) } as any,
      {} as any,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  function buildPendingTrip() {
    return {
      id: 'trip-1',
      driverId: 'driver-1',
      status: TripStatus.PENDING,
      startedAt: null,
      estimatedArrivalDate: null,
      departureDate: new Date('2026-05-20T12:00:00.000Z'),
      departureLocation: 'Gombe',
      departureReference: null,
      departurePoint: {
        type: 'Point',
        coordinates: [15.2663, -4.325],
      },
      arrivalLocation: 'Limete',
      arrivalReference: null,
      arrivalPoint: {
        type: 'Point',
        coordinates: [15.3222, -4.4419],
      },
      currentLocation: null,
      availableSeats: 0,
      pricePerSeat: 0,
      bookings: [],
      driverSafetyEmergencyContactIds: [],
      driver: { id: 'driver-1', fcmToken: null },
      vehicle: null,
    };
  }

  it('stores an estimated arrival date when a driver starts a trip', async () => {
    jest.useFakeTimers().setSystemTime(now);
    const trip = buildPendingTrip();
    tripRepository.findOne
      .mockResolvedValueOnce(trip)
      .mockResolvedValueOnce(null);
    jest.spyOn(service, 'findOne').mockResolvedValue({ id: 'trip-1' });

    await service.startTrip('trip-1', 'driver-1');

    expect(googleMapsService.getDirections).toHaveBeenCalledWith(
      expect.objectContaining({
        origin: { lat: -4.325, lng: 15.2663 },
        destination: { lat: -4.4419, lng: 15.3222 },
        mode: 'driving',
        departureTime: Math.floor(now.getTime() / 1000),
        region: 'CD',
      }),
    );
    expect(tripRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        status: TripStatus.ACTIVE,
        startedAt: now,
        estimatedArrivalDate: new Date('2026-05-20T12:30:00.000Z'),
      }),
    );
  });

  it('increases the ETA by 40 percent during heavy rain', async () => {
    jest.useFakeTimers().setSystemTime(now);
    const trip = buildPendingTrip();
    weatherAwarenessService.getRouteImpact.mockResolvedValueOnce({
      heavyRain: true,
      dataAvailable: true,
      priceMultiplier: 1.3,
      etaMultiplier: 1.4,
      evaluatedZoneIds: ['cd-kinshasa-gombe'],
      affectedZoneIds: ['cd-kinshasa-gombe'],
    });
    tripRepository.findOne
      .mockResolvedValueOnce(trip)
      .mockResolvedValueOnce(null);
    jest.spyOn(service, 'findOne').mockResolvedValue({ id: 'trip-1' });

    await service.startTrip('trip-1', 'driver-1');

    expect(tripRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        estimatedArrivalDate: new Date('2026-05-20T12:42:00.000Z'),
      }),
    );
  });

  it('does not expire a started trip before six hours after its estimated arrival', async () => {
    tripRepository.find.mockResolvedValueOnce([]);

    await service.markExpiredTripsNow(now);

    expect(tripRepository.find).toHaveBeenCalledTimes(1);
    expect(tripRepository.update).not.toHaveBeenCalled();
    expect(bookingRepository.update).not.toHaveBeenCalled();
  });

  it('does not expire a started trip even once six hours have passed after its estimated arrival', async () => {
    tripRepository.find.mockResolvedValueOnce([]);

    await service.markExpiredTripsNow(now);

    expect(tripRepository.find).toHaveBeenCalledTimes(1);
    expect(tripRepository.update).not.toHaveBeenCalled();
    expect(bookingRepository.update).not.toHaveBeenCalled();
  });
});

describe('TripsService interrupted trip fare location', () => {
  it('uses the driver interruption point for every onboard booking', async () => {
    const interruptionPoint = {
      type: 'Point' as const,
      coordinates: [15.3063, -4.365],
    };
    const trip = {
      id: 'trip-1',
      status: TripStatus.ACTIVE,
      totalSeats: 3,
      availableSeats: 0,
      currentLocation: {
        type: 'Point' as const,
        coordinates: [15.3, -4.36],
      },
      bookings: [],
    };
    const interruptionRequest = {
      id: 'request-1',
      tripId: 'trip-1',
      requestedLocation: interruptionPoint,
      trip,
      confirmations: [
        {
          bookingId: 'booking-1',
          status: 'confirmed',
        },
        {
          bookingId: 'booking-2',
          status: 'confirmed',
        },
      ],
    };
    const tripRepository = {
      findOne: jest.fn().mockResolvedValue(trip),
      save: jest.fn().mockImplementation(async (payload) => payload),
    };
    const driverInterruptionRepository = {
      findOne: jest.fn().mockResolvedValue(interruptionRequest),
      save: jest.fn().mockImplementation(async (payload) => payload),
    };
    const bookingsService = {
      completeBookingByTripInterruption: jest.fn().mockResolvedValue(undefined),
    };
    const service: any = new TripsService(
      tripRepository as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      driverInterruptionRepository as any,
      {} as any,
      { del: jest.fn() } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      bookingsService as any,
    );
    jest
      .spyOn(service, 'calculateAvailableSeatsAfterInterruption')
      .mockReturnValue(3);
    jest
      .spyOn(service, 'invalidateDriverInterruptionCaches')
      .mockResolvedValue(undefined);
    jest
      .spyOn(service, 'notifyDriverAboutDriverInterruptionCompleted')
      .mockResolvedValue(undefined);
    jest
      .spyOn(service, 'notifyPassengersAboutDriverInterruptionCompleted')
      .mockResolvedValue(undefined);

    await service.finalizeDriverTripInterruption({ id: 'request-1' });

    expect(
      bookingsService.completeBookingByTripInterruption,
    ).toHaveBeenNthCalledWith(1, 'booking-1', interruptionPoint);
    expect(
      bookingsService.completeBookingByTripInterruption,
    ).toHaveBeenNthCalledWith(2, 'booking-2', interruptionPoint);
    expect(tripRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        status: TripStatus.PENDING,
        availableSeats: 3,
      }),
    );
  });
});
