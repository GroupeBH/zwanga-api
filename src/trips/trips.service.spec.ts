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

describe('TripsService trip start rules', () => {
  let service: any;
  let tripRepository: {
    findOne: jest.Mock;
    save: jest.Mock;
  };
  let cacheService: { del: jest.Mock };

  const pendingTrip = {
    id: 'trip-1',
    driverId: 'driver-1',
    status: TripStatus.PENDING,
    availableSeats: 2,
    bookings: [],
  };

  beforeEach(() => {
    tripRepository = {
      findOne: jest.fn(),
      save: jest.fn().mockImplementation((trip) => Promise.resolve(trip)),
    };
    cacheService = {
      del: jest.fn().mockResolvedValue(undefined),
    };

    service = new TripsService(
      tripRepository as any,
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
    );

    jest.spyOn(service, 'findOne').mockResolvedValue({ id: 'trip-1' });
    jest
      .spyOn(service, 'notifyDriverEmergencyContacts')
      .mockResolvedValue(undefined);
    jest.spyOn(service, 'notifyNearbyUsersAboutTripStart').mockResolvedValue(undefined);
    jest
      .spyOn(service, 'notifyBookedPassengersAboutTripStart')
      .mockResolvedValue(undefined);
  });

  it('blocks starting a trip when the driver already has an active trip', async () => {
    tripRepository.findOne
      .mockResolvedValueOnce({ ...pendingTrip })
      .mockResolvedValueOnce({ id: 'active-trip' });

    await expect(service.startTrip('trip-1', 'driver-1')).rejects.toBeInstanceOf(
      BadRequestException,
    );

    expect(tripRepository.save).not.toHaveBeenCalled();
  });

  it('starts a pending trip when the driver has no other active trip', async () => {
    tripRepository.findOne
      .mockResolvedValueOnce({ ...pendingTrip })
      .mockResolvedValueOnce(null);

    await expect(service.startTrip('trip-1', 'driver-1')).resolves.toEqual({
      id: 'trip-1',
    });

    expect(tripRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'trip-1',
        status: TripStatus.ACTIVE,
        startedAt: expect.any(Date),
      }),
    );
  });

  it('returns a domain error when the database active-trip constraint is hit', async () => {
    tripRepository.findOne
      .mockResolvedValueOnce({ ...pendingTrip })
      .mockResolvedValueOnce(null);
    tripRepository.save.mockRejectedValueOnce({
      code: '23505',
      constraint: 'IDX_trips_one_active_per_driver',
    });

    await expect(service.startTrip('trip-1', 'driver-1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('routes status=ACTIVE updates through startTrip', async () => {
    tripRepository.findOne.mockResolvedValueOnce({ ...pendingTrip });
    const startTripSpy = jest
      .spyOn(service, 'startTrip')
      .mockResolvedValue({ id: 'trip-1' });

    await expect(
      service.update('trip-1', 'driver-1', { status: TripStatus.ACTIVE }),
    ).resolves.toEqual({ id: 'trip-1' });

    expect(startTripSpy).toHaveBeenCalledWith('trip-1', 'driver-1');
  });
});
