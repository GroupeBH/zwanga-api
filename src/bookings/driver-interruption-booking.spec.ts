import { BookingsService } from './bookings.service';
import { calculateInterruptionFare } from './interruption-fare';
import { BookingPaymentStatus, BookingStatus } from './entities/booking.entity';
import { TripPaymentMode } from '../payments/enums/trip-payment-mode.enum';

describe('interruption booking settlement', () => {
  const make = () => {
    const service: any = Object.create(BookingsService.prototype);
    const booking: any = {
      id: 'booking',
      tripId: 'trip',
      passengerId: 'passenger',
      paymentAmount: 10000,
      grossPaymentAmount: 10000,
      paymentStatus: BookingPaymentStatus.PENDING,
      paymentMode: TripPaymentMode.POINTS,
      pickedUp: true,
      status: BookingStatus.ACCEPTED,
      trip: { pricePerSeat: 99999 },
    };
    const quote = {
      ...calculateInterruptionFare(10000, 10000, 25000, 5000),
      id: 'quote',
      requestId: 'request',
      bookingId: 'booking',
      prepaidAmount: 0,
    };
    const manager: any = { save: jest.fn(async (_entity, value) => value) };
    service.bookingRepository = { findOne: jest.fn(async () => booking) };
    service.walletService = { creditBookingFareAdjustment: jest.fn() };
    service.settlePaymentAfterArrival = jest.fn(async (value) => value);
    service.invalidateBookingCaches = jest.fn();
    return { service, booking, quote, manager };
  };
  it('persists the shown amount and prevents subsidy or live trip price recalculation', async () => {
    const f = make();
    await f.service.applyDriverInterruptionFare(f.booking, f.quote, f.manager);
    expect(f.booking.status).toBe(BookingStatus.COMPLETED);
    expect(f.booking.interruptionFareLocked).toBe(true);
    expect(f.booking.paymentAmount).toBe(2000);
    expect(f.booking.trip.pricePerSeat).toBe(99999);
    expect(
      f.service.resolveBookingPaymentAmount(f.booking, f.booking.trip),
    ).toBe(2000);
    await f.service.applyFirstTripSubsidyPolicy(f.booking, f.booking.trip);
    expect(f.booking.paymentAmount).toBe(2000);
  });
  it('never refunds the unpaid original price when a reduced fare has since been paid', async () => {
    const f = make();
    await f.service.applyDriverInterruptionFare(f.booking, f.quote, f.manager);
    f.booking.paymentStatus = BookingPaymentStatus.SUCCEEDED;
    await f.service.settleDriverInterruptionFare(
      'booking',
      f.quote.prepaidAmount,
    );
    expect(
      f.service.walletService.creditBookingFareAdjustment,
    ).not.toHaveBeenCalled();
  });
  it('refunds only the difference of an actually prepaid fare', async () => {
    const f = make();
    f.booking.paymentStatus = BookingPaymentStatus.SUCCEEDED;
    await f.service.applyDriverInterruptionFare(f.booking, f.quote, f.manager);
    expect(f.quote.prepaidAmount).toBe(10000);
    await f.service.settleDriverInterruptionFare(
      'booking',
      f.quote.prepaidAmount,
    );
    expect(
      f.service.walletService.creditBookingFareAdjustment,
    ).toHaveBeenCalledWith(f.booking, 8000);
  });
  it('does not alter an in-flight electronic payment', async () => {
    const f = make();
    f.booking.paymentTransactionId = 'payment';
    await expect(
      f.service.applyDriverInterruptionFare(f.booking, f.quote, f.manager),
    ).rejects.toThrow();
    expect(f.manager.save).not.toHaveBeenCalled();
    expect(f.booking.paymentAmount).toBe(10000);
  });
  it('rejects a changed price before finalizing a reservation', async () => {
    const f = make();
    f.booking.paymentAmount = 8000;
    await expect(
      f.service.applyDriverInterruptionFare(f.booking, f.quote, f.manager),
    ).rejects.toThrow();
    expect(f.manager.save).not.toHaveBeenCalled();
  });

  it('a repeated callback for the original prepaid amount cannot restore the full fare', async () => {
    const f = make();
    f.booking.paymentStatus = BookingPaymentStatus.SUCCEEDED;
    await f.service.applyDriverInterruptionFare(f.booking, f.quote, f.manager);
    f.service.bookingRepository.save = jest.fn(async (value) => value);
    f.service.finalizeCompletedBooking = jest.fn();
    await f.service.applyPaymentToBooking(f.booking, {
      id: 'payment', reference: 'reference', amount: 10000, currency: 'CDF', status: 'succeeded',
    });
    expect(f.booking.paymentAmount).toBe(2000);
    expect(f.booking.grossPaymentAmount).toBe(2000);
  });
});
