import { BookingsService } from './bookings.service';
import { attachBookingRoutePreviews } from '../common/route-preview';

jest.mock('../common/route-preview', () => ({ attachBookingRoutePreviews: jest.fn().mockResolvedValue(undefined) }));

describe('Passenger pickup vehicle reads', () => {
  it.each([true, false])('includes the assigned trip vehicle in passenger bookings (activity=%s)', async (activityOnly) => {
    const vehicle = { id: 'vehicle', brand: 'Toyota', model: 'Yaris', color: 'rouge', licensePlate: '1234AB01' };
    const bookings = [{ id: 'booking', tripId: 'trip', passengerId: 'holder', numberOfSeats: 3,
      trip: { id: 'trip', vehicleId: vehicle.id, vehicle } }];
    const repository = { find: jest.fn().mockResolvedValue(bookings) };
    const cache = { get: jest.fn().mockResolvedValue(undefined), set: jest.fn().mockResolvedValue(undefined) };
    const service = Object.assign(Object.create(BookingsService.prototype), {
      bookingRepository: repository, cacheService: cache, CACHE_TTL: 60,
      logger: { debug: jest.fn() }, attachActiveInterruptionRequestsToBookings: jest.fn().mockResolvedValue(undefined),
    }) as BookingsService;

    const result = await service.findAllByPassenger('holder', activityOnly);

    expect(repository.find).toHaveBeenCalledTimes(1);
    const options = repository.find.mock.calls[0][0];
    expect(options.relations).toEqual(['trip', 'trip.driver', 'trip.vehicle']);
    const filters = Array.isArray(options.where) ? options.where : [options.where];
    expect(filters.every((filter: { passengerId: string }) => filter.passengerId === 'holder')).toBe(true);
    expect(result).toBe(bookings);
    expect(result[0].trip.vehicle).toBe(vehicle);
    expect(result[0].numberOfSeats).toBe(3);
    expect(attachBookingRoutePreviews).toHaveBeenCalledWith(cache, bookings);
    if (activityOnly) {
      expect(cache.get).not.toHaveBeenCalled(); expect(cache.set).not.toHaveBeenCalled();
    } else {
      expect(cache.get).toHaveBeenCalledTimes(1); expect(cache.set).toHaveBeenCalledTimes(1);
    }
  });
});
