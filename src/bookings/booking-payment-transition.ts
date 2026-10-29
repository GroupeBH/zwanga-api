import { Booking, BookingPaymentStatus } from './entities/booking.entity';
import {
  PaymentStatus,
  PaymentTransaction,
} from '../payments/entities/payment-transaction.entity';
import { TripPaymentMode } from '../payments/enums/trip-payment-mode.enum';

/** Called on the locked, authoritative booking, never on a caller's stale snapshot. */
export function canApplyBookingPayment(
  booking: Booking,
  payment: PaymentTransaction,
): boolean {
  const sameAttempt = booking.paymentTransactionId === payment.id;
  if (booking.paymentStatus === BookingPaymentStatus.SUCCEEDED) {
    // A second successful historical attempt requires review, not a second earning or relinking.
    return (
      booking.paymentMode === TripPaymentMode.ELECTRONIC &&
      payment.status === PaymentStatus.SUCCEEDED &&
      (sameAttempt ||
        (!booking.paymentTransactionId &&
          booking.paymentMode === TripPaymentMode.ELECTRONIC))
    );
  }
  if (payment.status !== PaymentStatus.SUCCEEDED) {
    if (booking.paymentMode !== TripPaymentMode.ELECTRONIC) return false;
    if (booking.paymentTransactionId && !sameAttempt) return false;
    if (
      [BookingPaymentStatus.FAILED, BookingPaymentStatus.CANCELLED].includes(
        booking.paymentStatus,
      ) &&
      [PaymentStatus.PENDING, PaymentStatus.INITIATED].includes(payment.status)
    )
      return false;
  }
  return true;
}
