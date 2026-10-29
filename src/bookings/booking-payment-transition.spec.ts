import { canApplyBookingPayment } from './booking-payment-transition';
import { Booking, BookingPaymentStatus as B } from './entities/booking.entity';
import {
  PaymentStatus as P,
  PaymentTransaction,
} from '../payments/entities/payment-transaction.entity';
import { TripPaymentMode } from '../payments/enums/trip-payment-mode.enum';

describe('booking payment attempt ordering', () => {
  const booking = (status = B.INITIATED, mode = TripPaymentMode.ELECTRONIC) =>
    ({
      paymentTransactionId: 'current',
      paymentStatus: status,
      paymentMode: mode,
    }) as Booking;
  const payment = (status: P, id = 'current') =>
    ({ status, id }) as PaymentTransaction;
  it.each([P.PENDING, P.INITIATED, P.FAILED, P.CANCELLED])(
    'never downgrades a paid booking to %s',
    (status) => {
      expect(
        canApplyBookingPayment(booking(B.SUCCEEDED), payment(status)),
      ).toBe(false);
    },
  );
  it.each([P.PENDING, P.INITIATED, P.FAILED, P.CANCELLED])(
    'ignores another attempt with status %s',
    (status) => {
      expect(canApplyBookingPayment(booking(), payment(status, 'old'))).toBe(
        false,
      );
    },
  );
  it('accepts a late proven success while unpaid, but not a second success after settlement', () => {
    expect(canApplyBookingPayment(booking(), payment(P.SUCCEEDED, 'old'))).toBe(
      true,
    );
    expect(
      canApplyBookingPayment(booking(B.SUCCEEDED), payment(P.SUCCEEDED, 'old')),
    ).toBe(false);
    expect(
      canApplyBookingPayment(booking(B.SUCCEEDED), payment(P.SUCCEEDED)),
    ).toBe(true);
  });
  it.each([B.FAILED, B.CANCELLED])(
    'does not reopen a terminal attempt (%s)',
    (status) => {
      expect(
        canApplyBookingPayment(booking(status), payment(P.INITIATED)),
      ).toBe(false);
      expect(
        canApplyBookingPayment(booking(status), payment(P.SUCCEEDED)),
      ).toBe(true);
    },
  );
  it.each([TripPaymentMode.CASH, TripPaymentMode.POINTS])(
    'preserves the chosen %s mode on failure',
    (mode) => {
      expect(
        canApplyBookingPayment(booking(B.PENDING, mode), payment(P.FAILED)),
      ).toBe(false);
      expect(
        canApplyBookingPayment(
          booking(B.SUCCEEDED, mode),
          payment(P.SUCCEEDED),
        ),
      ).toBe(false);
    },
  );
});
