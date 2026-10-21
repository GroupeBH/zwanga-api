import { BookingsService } from './bookings.service';
import { Booking, BookingStatus } from './entities/booking.entity';
import { TripStatus } from '../trips/entities/trip.entity';

describe('all driver reply entry points share a transactional outbox', () => {
  const fixture = () => {
    const booking: any = { id: 'booking-test', tripId: 'trip-test', passengerId: 'passenger-test',
      numberOfSeats: 1, status: BookingStatus.PENDING };
    const trip: any = { id: 'trip-test', driverId: 'driver-test', status: TripStatus.PENDING, totalSeats: 4 };
    const values = jest.fn().mockReturnThis();
    const insert = { insert: jest.fn().mockReturnThis(), into: jest.fn().mockReturnThis(),
      values, onConflict: jest.fn().mockReturnThis(), execute: jest.fn() };
    const manager = { createQueryBuilder: () => insert, getRepository: (entity: unknown) => ({
      findOne: async () => entity === Booking ? booking : trip, save: async value => value,
    }) };
    const service: any = Object.assign(Object.create(BookingsService.prototype), {
      bookingRepository: { manager: { transaction: async work => work(manager) } },
      ensurePassengerKycApprovedForTrip: jest.fn(), getAcceptedSeatCount: jest.fn(async () => 0),
      invalidateBookingCaches: jest.fn(), refundPointsPaymentIfNeeded: jest.fn(),
      recalculateAvailableSeatsForTrip: jest.fn(), releaseFirstTripSubsidyReservation: jest.fn(),
      notificationService: { sendNotification: jest.fn() }, logger: { log() {}, warn() {} },
    });
    return { service, booking, trip, values, insert };
  };
  it.each(['accept-screen', 'decline-screen', 'accept-native', 'decline-native'])('%s writes a response without a device token', async mode => {
    const f = fixture(); const accept = mode.startsWith('accept');
    const reply = () => mode.endsWith('native')
      ? f.service.respondToInvitation('booking-test', 'driver-test', accept)
      : accept ? f.service.acceptBooking('booking-test', 'driver-test')
        : f.service.rejectBooking('booking-test', 'driver-test', 'Indisponible');
    await reply();
    const status = accept ? 'accepted' : 'rejected';
    expect(f.values).toHaveBeenCalledWith(expect.objectContaining({
      eventKey: `booking-response:booking-test:${status}`, userId: 'passenger-test',
      data: expect.objectContaining({ type: 'booking_response', status }),
    }));
    expect(f.insert.onConflict).toHaveBeenCalledWith('("eventKey") DO NOTHING');
    await reply();
    expect(f.values).toHaveBeenCalledTimes(1);
    expect(f.service.notificationService.sendNotification).not.toHaveBeenCalled();
  });
  it('private request acceptance does not create a duplicate booking response', async () => {
    const f = fixture(); f.trip.tripRequestId = 'request-test';
    await f.service.acceptBooking('booking-test', 'driver-test');
    expect(f.values).not.toHaveBeenCalled();
  });
  it('an outbox insertion failure aborts before the booking decision is changed', async () => {
    const f = fixture(); f.insert.execute.mockRejectedValue(Error('synthetic database failure'));
    await expect(f.service.acceptBooking('booking-test', 'driver-test')).rejects.toThrow('synthetic');
    expect(f.booking.status).toBe(BookingStatus.PENDING);
    expect(f.service.notificationService.sendNotification).not.toHaveBeenCalled();
  });
});
