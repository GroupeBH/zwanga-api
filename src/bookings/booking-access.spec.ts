import { NotFoundException } from '@nestjs/common';
import type { RideDeclarationsService } from '../ride-declarations/ride-declarations.service';
import type { Booking } from './entities/booking.entity';
import { BookingsController } from './bookings.controller';
import { BookingsService } from './bookings.service';

describe('booking detail participant access', () => {
  const booking = {
    id: 'booking',
    passengerId: 'passenger',
    trip: { driverId: 'driver' },
  };
  let service: BookingsService;
  let repository: { exists: jest.Mock; findOne: jest.Mock };
  let cache: { get: jest.Mock; set: jest.Mock };

  beforeEach(() => {
    repository = {
      exists: jest.fn().mockResolvedValue(true),
      findOne: jest.fn().mockResolvedValue(booking),
    };
    cache = { get: jest.fn(), set: jest.fn() };
    service = Object.assign(
      Object.create(BookingsService.prototype) as BookingsService,
      {
        bookingRepository: repository,
        cacheService: cache,
        logger: { debug: jest.fn(), warn: jest.fn() },
        passengerTripInterruptionRepository: {
          find: jest.fn().mockResolvedValue([]),
        },
        driverTripInterruptionRepository: {
          find: jest.fn().mockResolvedValue([]),
        },
      },
    );
  });

  it('passes the authenticated viewer, never a client-provided identity', async () => {
    const read = jest
      .spyOn(service, 'findOneForViewer')
      .mockResolvedValue(booking as Booking);
    const controller = new BookingsController(
      service,
      {} as RideDeclarationsService,
    );
    await controller.findOne({ user: { userId: 'viewer' } }, booking.id);
    expect(read).toHaveBeenCalledWith(booking.id, 'viewer');
  });

  it.each(['passenger', 'driver'])(
    'permits %s after a live, parameterized ownership check',
    async (viewer) => {
      cache.get.mockResolvedValue(booking);
      expect(await service.findOneForViewer(booking.id, viewer)).toBe(booking);
      expect(repository.exists).toHaveBeenCalledWith({
        where: [
          { id: booking.id, passengerId: viewer },
          { id: booking.id, trip: { driverId: viewer } },
        ],
      });
      expect(repository.exists.mock.invocationCallOrder[0]).toBeLessThan(
        cache.get.mock.invocationCallOrder[0],
      );
    },
  );

  it('rejects a non-participant before loading even a cached detail', async () => {
    repository.exists.mockResolvedValue(false);
    cache.get.mockResolvedValue(booking);
    await expect(
      service.findOneForViewer(booking.id, 'outsider'),
    ).rejects.toThrow(NotFoundException);
    expect(cache.get).not.toHaveBeenCalled();
    expect(repository.findOne).not.toHaveBeenCalled();
  });

  it('rejects missing viewer identity without broadening an ORM query', async () => {
    await expect(
      service.findOneForViewer(booking.id, undefined as unknown as string),
    ).rejects.toThrow(NotFoundException);
    expect(repository.exists).not.toHaveBeenCalled();
    expect(cache.get).not.toHaveBeenCalled();
  });

  it('fails closed if the ownership query fails, even with a populated cache', async () => {
    repository.exists.mockRejectedValue(new Error('database unavailable'));
    cache.get.mockResolvedValue(booking);
    await expect(
      service.findOneForViewer(booking.id, 'driver'),
    ).rejects.toThrow('database unavailable');
    expect(cache.get).not.toHaveBeenCalled();
  });

  it('preserves internal reads used after separately authorized mutations', async () => {
    cache.get.mockResolvedValue(booking);
    expect(await service.findOne(booking.id)).toBe(booking);
    expect(repository.exists).not.toHaveBeenCalled();
  });
});
