import { BadRequestException } from '@nestjs/common';
import { TripsService } from './trips.service';
import { UserRole } from '../users/entities/user.entity';

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
