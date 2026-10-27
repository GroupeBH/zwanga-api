import { ConflictException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import {
  Booking,
  BookingPaymentStatus,
  BookingStatus,
} from '../bookings/entities/booking.entity';
import { TripPaymentMode } from '../payments/enums/trip-payment-mode.enum';
import {
  DriverEarning,
  DriverEarningStatus,
} from './entities/driver-earning.entity';

export function earningReconciliationRequired(): ConflictException {
  return new ConflictException({
    code: 'DRIVER_EARNING_RECONCILIATION_REQUIRED',
    message:
      'Le règlement de ce trajet doit être vérifié. Actualisez le paiement. Si le problème persiste, contactez l’assistance.',
  });
}

const cents = (value: unknown) =>
  value === null || value === undefined || !Number.isFinite(Number(value))
    ? NaN
    : Math.round(Number(value) * 100);

/** Called with the booking and its existing earning locked, after confirmed
 * payment. Replace only a proven subsidy-only credit; never erase a mismatch,
 * re-credit the subsidy, revive a cancelled entry or reduce withdrawn funds. */
export async function upgradePaidCashSubsidy(
  manager: EntityManager,
  existing: DriverEarning,
  booking: Booking,
  next: Omit<DriverEarning, 'id' | 'createdAt' | 'updatedAt'> | null,
): Promise<DriverEarning> {
  const gross = cents(booking.grossPaymentAmount);
  const passenger = cents(booking.paymentAmount);
  const subsidy = cents(booking.zwangaSubsidyAmount);
  if (
    !next ||
    booking.status !== BookingStatus.COMPLETED ||
    booking.paymentStatus !== BookingPaymentStatus.SUCCEEDED ||
    ![TripPaymentMode.POINTS, TripPaymentMode.ELECTRONIC].includes(
      booking.paymentMode,
    ) ||
    !booking.firstTripSubsidyApplied ||
    booking.mixedPaymentAt ||
    Number(booking.mixedTokenAmount ?? 0) !== 0 ||
    Number(booking.mixedTokenQuantity ?? 0) !== 0 ||
    booking.cashReceivedAt ||
    booking.tokenCashFallbackAt ||
    !(
      gross > 0 &&
      passenger >= 0 &&
      subsidy > 0 &&
      gross === passenger + subsidy
    ) ||
    existing.paymentMode !== TripPaymentMode.CASH ||
    existing.status !== DriverEarningStatus.AVAILABLE ||
    existing.paidAt ||
    existing.bookingId !== booking.id ||
    existing.tripId !== booking.tripId ||
    existing.passengerId !== booking.passengerId ||
    existing.driverId !== booking.trip?.driverId ||
    existing.currency !== next.currency ||
    cents(existing.grossAmount) !== subsidy ||
    cents(existing.netAmount) !== subsidy ||
    Number(existing.commissionRate) !== 0 ||
    cents(existing.commissionAmount) !== 0 ||
    cents(next.grossAmount) !== gross ||
    cents(next.netAmount) < subsidy ||
    cents(next.grossAmount) !==
      cents(next.netAmount) + cents(next.commissionAmount)
  ) {
    throw earningReconciliationRequired();
  }
  // Payouts are subtracted separately from aggregate earnings. Keeping the
  // same entry/id increases the balance only by the newly funded net portion.
  return manager.save(
    manager.create(DriverEarning, {
      ...existing,
      ...next,
      availableAt: existing.availableAt,
    }),
  );
}
