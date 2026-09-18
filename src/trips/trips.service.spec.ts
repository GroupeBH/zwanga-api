import { BadRequestException } from '@nestjs/common';
import { TripsService } from './trips.service';
import { UserRole } from '../users/entities/user.entity';
import { TripStatus } from './entities/trip.entity';
import { BookingStatus } from '../bookings/entities/booking.entity';
import { VehicleType } from '../vehicles/entities/vehicle.entity';

describe('TripsService daily trip publication quota', () => {
  let service: any;
  let tripRepository: {
    create: jest.Mock;
    save: jest.Mock;
    update: jest.Mock;
    findOne: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let userRepository: { findOne: jest.Mock; save: jest.Mock };
  let vehicleRepository: { findOne: jest.Mock };
  let subscriptionsService: { getPremiumOverview: jest.Mock };
  let cacheService: { del: jest.Mock };
  let driverSettlementsService: { notifyDriverTripRevenue: jest.Mock };

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
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      findOne: jest.fn(),
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
    vehicleRepository = {
      findOne: jest.fn(),
    };
    subscriptionsService = {
      getPremiumOverview: jest.fn(),
    };
    cacheService = {
      del: jest.fn().mockResolvedValue(undefined),
    };
    driverSettlementsService = {
      notifyDriverTripRevenue: jest.fn().mockResolvedValue(null),
    };

    service = new TripsService(
      tripRepository as any,
      {} as any,
      {} as any,
      userRepository as any,
      vehicleRepository as any,
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
      driverSettlementsService as any,
      { awardLoyaltyForCompletedTrip: jest.fn().mockResolvedValue(null) } as any,
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

  it.each([
    { pricePerSeat: 3500 },
    { pricePerSeat: 0 },
    { isFree: true },
    { pricePerSeat: 2000, isFree: true },
    { pricePerSeat: null },
    { pricePerSeat: 3500, status: TripStatus.ACTIVE },
  ])('rejects a linked-trip price change before any write: %j', async (payload) => {
    const trip = { id: 'trip-1', driverId: 'driver-1', tripRequestId: 'request-1',
      pricePerSeat: '2000.00', isFree: false, status: TripStatus.PENDING };
    tripRepository.findOne.mockResolvedValue(trip);
    const startTrip = jest.spyOn(service, 'startTrip');

    await expect(service.update(trip.id, trip.driverId, payload)).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'TRIP_REQUEST_PRICE_LOCKED' }),
    });
    expect(startTrip).not.toHaveBeenCalled();
    expect(tripRepository.save).not.toHaveBeenCalled();
    expect(tripRepository.update).not.toHaveBeenCalled();
    expect(trip.pricePerSeat).toBe('2000.00');
  });

  it.each([undefined, 2000])('allows other linked-trip edits with the same or omitted price: %s', async (pricePerSeat) => {
    const trip = { id: 'trip-1', driverId: 'driver-1', tripRequestId: 'request-1',
      pricePerSeat: '2000.00', isFree: false, status: TripStatus.PENDING, bookings: [] };
    tripRepository.findOne.mockResolvedValue(trip);

    await service.update(trip.id, trip.driverId, { description: 'Point de rendez-vous confirmé',
      ...(pricePerSeat !== undefined ? { pricePerSeat, isFree: false } : {}) });

    expect(Number(trip.pricePerSeat)).toBe(2000);
    expect(tripRepository.save).toHaveBeenCalledWith(expect.objectContaining({ description: 'Point de rendez-vous confirmé' }));
  });

  it('keeps ordinary published-trip pricing editable', async () => {
    const trip = { id: 'trip-1', driverId: 'driver-1', tripRequestId: null,
      pricePerSeat: 2000, isFree: false, status: TripStatus.PENDING, bookings: [] };
    tripRepository.findOne.mockResolvedValue(trip);
    await service.update(trip.id, trip.driverId, { pricePerSeat: 3500 });
    expect(trip.pricePerSeat).toBe(3500);
    expect(tripRepository.save).toHaveBeenCalledWith(trip);
  });

  it('persists driver samples with a timestamp compare-and-set shared by REST and Socket.IO', async () => {
    const activeTrip = {
      id: 'trip-1',
      driverId: 'driver-1',
      status: TripStatus.ACTIVE,
      currentLocation: null,
      lastLocationUpdateAt: null,
      departurePoint: { type: 'Point', coordinates: [15.3, -4.3] },
      arrivalPoint: { type: 'Point', coordinates: [15.4, -4.4] },
    };
    jest.spyOn(service, 'verifyTripParticipant').mockResolvedValue({
      trip: activeTrip,
      isDriver: true,
    });
    const recordedAt = new Date().toISOString();

    const result = await service.updateDriverLocation(
      'driver-1',
      'trip-1',
      [15.31, -4.31],
      { recordedAt, accuracyMeters: 5 },
    );

    expect(tripRepository.update).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'trip-1',
        driverId: 'driver-1',
        status: TripStatus.ACTIVE,
        lastLocationUpdateAt: expect.anything(),
      }),
      expect.objectContaining({
        currentLocation: {
          type: 'Point',
          coordinates: [15.31, -4.31],
        },
        lastLocationUpdateAt: new Date(recordedAt),
      }),
    );
    expect(tripRepository.save).not.toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({
        tripId: 'trip-1',
        coordinates: [15.31, -4.31],
        updatedAt: new Date(recordedAt),
      }),
    );
  });

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

  it.each([
    [VehicleType.MOTORCYCLE_TWO_WHEELS, 2],
    [VehicleType.MOTORCYCLE_THREE_WHEELS, 3],
  ])('limits %s trips to %i places', async (type, maxSeats) => {
    vehicleRepository.findOne.mockResolvedValue({
      id: 'vehicle-1',
      ownerId: 'driver-1',
      type,
      isActive: true,
    });

    await expect(
      service.create('driver-1', {
        ...baseCreateTripDto,
        vehicleId: 'vehicle-1',
        totalSeats: maxSeats + 1,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(tripRepository.save).not.toHaveBeenCalled();
  });

  it('allows three places on a three-wheel motorcycle', async () => {
    subscriptionsService.getPremiumOverview.mockResolvedValue({
      isActive: true,
    });
    vehicleRepository.findOne.mockResolvedValue({
      id: 'vehicle-1',
      ownerId: 'driver-1',
      type: VehicleType.MOTORCYCLE_THREE_WHEELS,
      isActive: true,
    });

    await expect(
      service.create('driver-1', {
        ...baseCreateTripDto,
        vehicleId: 'vehicle-1',
        totalSeats: 3,
      }),
    ).resolves.toEqual({ id: 'trip-1' });
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
    update: jest.Mock;
    remove: jest.Mock;
  };
  let bookingRepository: { update: jest.Mock; delete: jest.Mock };
  let cacheService: { del: jest.Mock };

  beforeEach(() => {
    tripRepository = {
      findOne: jest.fn(),
      save: jest.fn().mockImplementation(async (trip) => trip),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
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
      { notifyDriverTripRevenue: jest.fn().mockResolvedValue(null) } as any,
      { awardLoyaltyForCompletedTrip: jest.fn().mockResolvedValue(null) } as any,
    );
  });

  it('blocks deletion of a trip linked to a passenger request', async () => {
    const trip = {
      id: 'trip-1',
      tripRequestId: 'request-1',
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

    await expect(service.remove('trip-1', 'driver-1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(bookingRepository.update).not.toHaveBeenCalled();
    expect(bookingRepository.delete).not.toHaveBeenCalled();
    expect(tripRepository.remove).not.toHaveBeenCalled();
  });

  it('pauses a linked trip without reopening or cancelling the request', async () => {
    const trip = {
      id: 'trip-request-active',
      tripRequestId: 'request-2',
      driverId: 'driver-1',
      status: TripStatus.ACTIVE,
      availableSeats: 1,
      bookings: [],
      driver: { id: 'driver-1' },
    };
    tripRepository.findOne.mockResolvedValue(trip);
    jest.spyOn(service, 'findOne').mockResolvedValue({
      id: trip.id,
      status: TripStatus.PENDING,
    });

    await expect(service.pauseTrip(trip.id, trip.driverId)).resolves.toEqual(
      expect.objectContaining({ status: TripStatus.PENDING }),
    );

    expect(trip.status).toBe(TripStatus.PENDING);
    expect(tripRepository.save).toHaveBeenCalledWith(trip);
  });

  it('blocks driver cancellation of a linked request trip', async () => {
    const trip = {
      id: 'trip-request-pending',
      tripRequestId: 'request-3',
      driverId: 'driver-1',
      status: TripStatus.PENDING,
      availableSeats: 1,
      bookings: [],
      vehicle: null,
    };
    tripRepository.findOne.mockResolvedValue(trip);
    await expect(
      service.update(trip.id, trip.driverId, {
        status: TripStatus.CANCELLED,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(trip.status).toBe(TripStatus.PENDING);
    expect(tripRepository.save).not.toHaveBeenCalled();
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

  it('publishes the driver revenue notification after one successful completion transition', async () => {
    const trip = {
      id: 'trip-completed-with-revenue',
      driverId: 'driver-1',
      status: TripStatus.ACTIVE,
      driverSafetyEmergencyContactIds: [],
      bookings: [
        {
          id: 'booking-completed',
          status: BookingStatus.COMPLETED,
          droppedOff: true,
        },
      ],
    };
    tripRepository.findOne.mockResolvedValue(trip);
    jest.spyOn(service, 'findOne').mockResolvedValue({ id: trip.id });

    await service.completeTrip(trip.id, trip.driverId);

    expect(service.walletService.awardLoyaltyForCompletedTrip).toHaveBeenCalledWith(
      expect.objectContaining({ id: trip.id, status: TripStatus.COMPLETED }),
    );
    expect(tripRepository.update).toHaveBeenCalledWith(
      { id: trip.id, driverId: trip.driverId, status: TripStatus.ACTIVE },
      expect.objectContaining({ status: TripStatus.COMPLETED }),
    );
    expect(
      service.driverSettlementsService.notifyDriverTripRevenue,
    ).toHaveBeenCalledWith(trip.driverId, trip.id);
  });

  it('rechecks missing loyalty on a completed-trip retry without repeating revenue notifications', async () => {
    const trip = {
      id: 'trip-retry', driverId: 'driver-1', status: TripStatus.COMPLETED,
      startedAt: new Date(Date.now() - 3600000), completedAt: new Date(),
    };
    tripRepository.findOne.mockResolvedValue(trip);
    jest.spyOn(service, 'findOne').mockResolvedValue(trip);
    await service.completeTrip(trip.id, trip.driverId);
    expect(service.walletService.awardLoyaltyForCompletedTrip).toHaveBeenCalledWith(trip);
    expect(service.driverSettlementsService.notifyDriverTripRevenue).not.toHaveBeenCalled();
    expect(tripRepository.update).not.toHaveBeenCalled();
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
      { notifyDriverTripRevenue: jest.fn().mockResolvedValue(null) } as any,
      { awardLoyaltyForCompletedTrip: jest.fn().mockResolvedValue(null) } as any,
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

describe('TripsService interruption confirmation', () => {
  it('notifies passengers about their choice after the atomic pause, without completing bookings', async () => {
    const service: any = Object.create(TripsService.prototype);
    const request = { id: 'request', trip: { id: 'trip', status: TripStatus.PENDING } };
    const workflow = { respond: jest.fn().mockResolvedValue({ request, confirmation: {}, paused: true }) };
    jest.spyOn(service, 'driverInterruptionWorkflow', 'get').mockReturnValue(workflow);
    service.driverTripInterruptionRepository = { findOneOrFail: jest.fn().mockResolvedValue(request) };
    service.notifyDriverAboutDriverInterruptionCompleted = jest.fn();
    service.notifyPassengersAboutDriverInterruptionCompleted = jest.fn();
    service.invalidateDriverInterruptionCaches = jest.fn();
    service.findOne = jest.fn().mockResolvedValue(request.trip);
    service.bookingsService = { completeBookingByTripInterruption: jest.fn() };
    await service.confirmDriverTripInterruption('trip', 'passenger', { bookingId: 'booking' });
    expect(workflow.respond).toHaveBeenCalledWith('trip', 'passenger', 'booking', true);
    expect(service.notifyPassengersAboutDriverInterruptionCompleted).toHaveBeenCalledWith(request.trip, request);
    expect(service.bookingsService.completeBookingByTripInterruption).not.toHaveBeenCalled();
  });
});
