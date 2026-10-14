import { TripsService } from './trips.service';
import { expirePendingTrip } from './expire-pending-trip';
import { CacheService } from '../common/services/cache.service';
import { BookingStatus } from '../bookings/entities/booking.entity';

jest.mock('./expire-pending-trip', () => ({ expirePendingTrip: jest.fn() }));
const expire = jest.mocked(expirePendingTrip);

describe('trip expiry cron orchestration', () => {
  beforeEach(() => jest.resetAllMocks());

  it('awaits the scheduled work instead of detaching it', async () => {
    const service: any = Object.create(TripsService.prototype);
    let release!: () => void;
    service.markExpiredTripsNow = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    let finished = false;
    const task = service.markExpiredTrips().then(() => {
      finished = true;
    });
    await Promise.resolve();
    expect(service.markExpiredTripsNow).toHaveBeenCalledTimes(1);
    expect(finished).toBe(false);
    release();
    await task;
    expect(finished).toBe(true);
  });

  it('paginates past failed candidates and only notifies the winning transition', async () => {
    const service: any = Object.create(TripsService.prototype);
    service.logger = { debug: jest.fn(), log: jest.fn(), error: jest.fn() };
    service.logTripStateChange = jest.fn();
    service.cacheService = { del: jest.fn().mockResolvedValue(undefined) };
    service.invalidateTripCaches = jest.fn().mockResolvedValue(undefined);
    for (const method of [
      'notifyDriverAboutTripExpiration',
      'notifyPassengersAboutTripExpiration',
      'notifyEmergencyContactsForMissingDropoff',
    ]) {
      service[method] = jest.fn().mockResolvedValue(undefined);
    }
    const firstBatch = Array.from({ length: 100 }, (_, index) => ({
      id: String(index).padStart(3, '0'),
    }));
    const expiredBooking = {
      id: 'booking',
      passengerId: 'passenger',
      status: BookingStatus.EXPIRED,
    };
    const trip = {
      id: '100',
      driverId: 'driver',
      availableSeats: 4,
      bookings: [expiredBooking, { id: 'unrelated' }],
    };
    service.tripRepository = {
      find: jest
        .fn()
        .mockResolvedValueOnce(firstBatch)
        .mockResolvedValueOnce([{ id: '100' }]),
      findOne: jest.fn().mockResolvedValue(trip),
    };
    expire.mockImplementation(async (_repository, id) => {
      if (id === '000') throw new Error('isolated failure');
      return id === '100'
        ? { bookingIds: ['booking'], restoredSeats: 2 }
        : null;
    });
    await service.markExpiredTripsNow(new Date('2026-10-14T12:00:00Z'));
    expect(expire).toHaveBeenCalledTimes(101);
    expect(service.tripRepository.find).toHaveBeenCalledTimes(2);
    expect(service.tripRepository.find.mock.calls[1][0]).toMatchObject({
      take: 100,
      select: ['id'],
      order: { id: 'ASC' },
      where: {
        id: expect.objectContaining({ _type: 'moreThan', _value: '099' }),
      },
    });
    expect(service.logger.error).toHaveBeenCalledTimes(1);
    expect(service.notifyDriverAboutTripExpiration).toHaveBeenCalledTimes(1);
    expect(service.notifyPassengersAboutTripExpiration).toHaveBeenCalledWith(
      trip,
      [expiredBooking],
    );
    expect(service.cacheService.del).toHaveBeenCalledWith(
      CacheService.getBookingKey('booking'),
    );
    expect(service.cacheService.del).toHaveBeenCalledWith(
      CacheService.getBookingsByPassengerKey('passenger'),
    );
    expect(service.cacheService.del).toHaveBeenCalledWith(
      CacheService.getBookingsByTripKey('100'),
    );
    expect(service.invalidateTripCaches).toHaveBeenCalledTimes(1);
  });
});
