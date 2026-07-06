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
      cacheService as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      subscriptionsService as any,
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
    remove: jest.Mock;
  };
  let bookingRepository: { delete: jest.Mock };
  let cacheService: { del: jest.Mock };

  beforeEach(() => {
    tripRepository = {
      findOne: jest.fn(),
      remove: jest.fn().mockResolvedValue(undefined),
    };
    bookingRepository = {
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
      cacheService as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
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
    expect(bookingRepository.delete).toHaveBeenCalledWith({ tripId: 'trip-1' });
    expect(tripRepository.remove).toHaveBeenCalledWith(trip);
  });

  it('blocks deleting a non-terminal trip when a booking is already accepted', async () => {
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

    await expect(service.remove('trip-2', 'driver-1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(bookingRepository.delete).not.toHaveBeenCalled();
    expect(tripRepository.remove).not.toHaveBeenCalled();
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
      cacheService as any,
      {} as any,
      {} as any,
      {} as any,
      googleMapsService as any,
      {} as any,
      weatherAwarenessService as any,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  function buildActiveTrip(estimatedArrivalDate: Date) {
    return {
      id: 'trip-active',
      driverId: 'driver-1',
      status: TripStatus.ACTIVE,
      startedAt: new Date('2026-05-20T02:00:00.000Z'),
      estimatedArrivalDate,
      departureDate: new Date('2026-05-20T02:00:00.000Z'),
      updatedAt: now,
      departureLocation: 'Gombe',
      departureReference: null,
      departurePoint: null,
      arrivalLocation: 'Limete',
      arrivalReference: null,
      arrivalPoint: null,
      bookings: [],
      driver: { id: 'driver-1', fcmToken: null },
    };
  }

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
    const estimatedArrivalDate = new Date(now.getTime() - 5 * 60 * 60 * 1000);
    tripRepository.find
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([buildActiveTrip(estimatedArrivalDate)]);

    await service.markExpiredTripsNow(now);

    expect(tripRepository.update).not.toHaveBeenCalled();
    expect(bookingRepository.update).not.toHaveBeenCalled();
  });

  it('expires a started trip once six hours have passed after its estimated arrival', async () => {
    const estimatedArrivalDate = new Date(
      now.getTime() - 6 * 60 * 60 * 1000 - 60 * 1000,
    );
    tripRepository.find
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([buildActiveTrip(estimatedArrivalDate)]);

    await service.markExpiredTripsNow(now);

    expect(tripRepository.update).toHaveBeenCalledWith('trip-active', {
      status: TripStatus.COMPLETED,
      completedAt: now,
    });
  });
});
