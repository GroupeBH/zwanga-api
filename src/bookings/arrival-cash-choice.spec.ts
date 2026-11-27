import { BookingsService } from './bookings.service';
import {
  Booking,
  BookingPaymentStatus,
  BookingStatus,
} from './entities/booking.entity';
import { TripPaymentMode } from '../payments/enums/trip-payment-mode.enum';

describe('arrival cash choice before a failed attempt', () => {
  it.each([TripPaymentMode.POINTS, TripPaymentMode.ELECTRONIC])(
    'switches %s without charging or acknowledging receipt',
    async (mode) => {
      const booking = {
        id: 'b',
        passengerId: 'u',
        status: BookingStatus.COMPLETED,
        droppedOff: true,
        paymentMode: mode,
        paymentStatus: BookingPaymentStatus.PENDING,
        paymentAmount: 4500,
      } as Booking;
      const service = {
        bookingRepository: { findOne: jest.fn().mockResolvedValue(booking) },
        findCurrentPaymentForBooking: jest.fn().mockResolvedValue(null),
        paymentsService: { checkPaymentStatus: jest.fn() },
        getTripPaymentCurrency: () => 'CDF',
        applyFirstTripSubsidyPolicy: jest.fn(),
        saveBookingWithFirstTripSubsidyRaceFallback: jest.fn((value: Booking) =>
          Promise.resolve(value),
        ),
        invalidateBookingCaches: jest.fn(),
      };
      const result: unknown =
        await BookingsService.prototype.updatePaymentMode.call(
          service,
          'b',
          'u',
          TripPaymentMode.CASH,
        );
      expect(result).toMatchObject({
        paymentMode: 'cash',
        paymentAmount: 4500,
        paymentStatus: 'not_required',
        paidAt: null,
      });
      expect(result).not.toHaveProperty('cashReceivedAt');
      expect(service.paymentsService.checkPaymentStatus).not.toHaveBeenCalled();
    },
  );
});
