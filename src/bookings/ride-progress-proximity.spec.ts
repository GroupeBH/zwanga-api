import { BookingsService } from './bookings.service';
import { BookingStatus } from './entities/booking.entity';

describe('destination proximity eligibility', () => {
  function fixture() {
    const service = Object.create(BookingsService.prototype) as any;
    service.calculateDistanceToDestination = jest.fn().mockResolvedValue(100);
    service.notifyDestinationProximity = jest.fn().mockResolvedValue(undefined);
    service.bookingRepository = { update: jest.fn().mockResolvedValue({ affected: 1 }) };
    service.logger = { log: jest.fn() };
    service.DESTINATION_PROXIMITY_THRESHOLD_METERS = 500;
    const booking = {
      id: 'booking', passengerId: 'passenger', status: BookingStatus.ACCEPTED,
      pickedUp: false, droppedOff: false, destinationProximityNotified: false,
      passengerDestinationPoint: { type: 'Point', coordinates: [15, -4] },
    };
    return { service, booking };
  }

  it('keeps the alert available until the passenger is picked up', async () => {
    const { service, booking } = fixture();
    await service.checkAndNotifyDestinationProximity(booking);
    expect(service.calculateDistanceToDestination).not.toHaveBeenCalled();
    expect(service.bookingRepository.update).not.toHaveBeenCalled();
    expect(booking.destinationProximityNotified).toBe(false);
    booking.pickedUp = true;
    await service.checkAndNotifyDestinationProximity(booking);
    expect(service.notifyDestinationProximity).toHaveBeenCalledWith(booking, 100);
    expect(booking.destinationProximityNotified).toBe(true);
  });

  it('does not enqueue proximity after dropoff', async () => {
    const { service, booking } = fixture();
    booking.pickedUp = true;
    booking.droppedOff = true;
    await service.checkAndNotifyDestinationProximity(booking);
    expect(service.bookingRepository.update).not.toHaveBeenCalled();
    expect(service.notifyDestinationProximity).not.toHaveBeenCalled();
  });
});
