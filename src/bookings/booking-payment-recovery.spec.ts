import { BookingsService } from './bookings.service';
import { Booking, BookingPaymentStatus, BookingStatus } from './entities/booking.entity';
import { PaymentStatus } from '../payments/entities/payment-transaction.entity';
import { TripPaymentMode } from '../payments/enums/trip-payment-mode.enum';

describe('booking payment mode recovery (service doubles, no production data)', () => {
  function fixture(status: PaymentStatus, orderNumber: string | null = 'order') {
    const booking = { id: 'b', passengerId: 'u', status: BookingStatus.COMPLETED, droppedOff: true,
      paymentMode: TripPaymentMode.ELECTRONIC, paymentStatus: BookingPaymentStatus.PENDING,
      paymentAmount: 4500, paymentReference: 'reference', paymentTransactionId: 'p' };
    const payment = { id: 'p', status, orderNumber };
    const service = Object.create(BookingsService.prototype) as any;
    service.bookingRepository = { findOne: jest.fn().mockResolvedValue(booking) };
    service.dataSource = { transaction: async work => work({
      findOne: async entity => entity === Booking ? booking : { id: 'trip' },
      save: async value => value,
    }) };
    service.findCurrentPaymentForBooking = jest.fn().mockResolvedValue(payment);
    service.paymentsService = { checkPaymentStatus: jest.fn().mockResolvedValue(payment) };
    service.getTripPaymentCurrency = () => 'CDF';
    service.applyFirstTripSubsidyPolicy = jest.fn();
    service.saveBookingWithFirstTripSubsidyRaceFallback = jest.fn(async value => value);
    service.invalidateBookingCaches = jest.fn();
    service.applyPaymentToBooking = jest.fn();
    return { service, booking, payment };
  }
  it.each([PaymentStatus.FAILED, PaymentStatus.CANCELLED])('allows cash after %s without a provider charge', async status => {
    const f = fixture(status);
    expect(await f.service.updatePaymentMode('b', 'u', TripPaymentMode.CASH)).toMatchObject({
      paymentMode: TripPaymentMode.CASH, paymentStatus: BookingPaymentStatus.NOT_REQUIRED,
      paymentReference: null, paymentTransactionId: null,
    });
    expect(f.service.paymentsService.checkPaymentStatus).not.toHaveBeenCalled();
  });
  it('reconciles an unresolved attempt before allowing another payment', async () => {
    const f = fixture(PaymentStatus.PENDING);
    f.service.paymentsService.checkPaymentStatus.mockResolvedValue({ ...f.payment, status: PaymentStatus.FAILED });
    expect((await f.service.updatePaymentMode('b', 'u', TripPaymentMode.CASH)).paymentMode).toBe(TripPaymentMode.CASH);
    expect(f.service.paymentsService.checkPaymentStatus).toHaveBeenCalledWith('order', 'u');
  });
  it.each([PaymentStatus.PENDING, PaymentStatus.INITIATED, PaymentStatus.SUCCEEDED])('does not change mode if the payment is %s', async status => {
    const f = fixture(status);
    await expect(f.service.updatePaymentMode('b', 'u', TripPaymentMode.CASH)).rejects.toMatchObject({ status: 409 });
    expect(f.service.saveBookingWithFirstTripSubsidyRaceFallback).not.toHaveBeenCalled();
    if (status === PaymentStatus.SUCCEEDED) expect(f.service.applyPaymentToBooking).toHaveBeenCalledWith(f.booking, f.payment);
  });
  it('a lost provider reply or missing reference never clears the original booking payment', async () => {
    for (const order of ['order', null]) {
      const f = fixture(PaymentStatus.PENDING, order);
      f.service.paymentsService.checkPaymentStatus.mockRejectedValue(new Error('network'));
      await expect(f.service.updatePaymentMode('b', 'u', TripPaymentMode.CASH)).rejects.toMatchObject({ status: 409 });
      expect(f.booking.paymentReference).toBe('reference');
    }
  });
  it.each([TripPaymentMode.CASH, TripPaymentMode.POINTS])('an old refusal never restores electronic mode over %s', async mode => {
    const f = fixture(PaymentStatus.FAILED); f.booking.paymentMode = mode;
    const result = await (BookingsService.prototype as any).applyPaymentToBooking.call(f.service, f.booking, f.payment);
    expect(result.paymentMode).toBe(mode);
    expect(f.service.saveBookingWithFirstTripSubsidyRaceFallback).not.toHaveBeenCalled();
  });
});
