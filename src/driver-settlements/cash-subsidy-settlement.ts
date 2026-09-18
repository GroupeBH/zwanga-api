import { DataSource, EntityManager } from 'typeorm';
import { Booking, BookingStatus } from '../bookings/entities/booking.entity';
import { TripPaymentMode } from '../payments/enums/trip-payment-mode.enum';
import { Trip, TripStatus } from '../trips/entities/trip.entity';
import { DriverEarning } from './entities/driver-earning.entity';

/** Shared by arrival and authorised recovery; serialises credits for one booking. */
export async function settleCashSubsidy(
  dataSource: DataSource,
  bookingId: string,
  record: (manager: EntityManager, booking: Booking) => Promise<DriverEarning | null>,
): Promise<{ earning: DriverEarning | null; created: boolean; tripStatus?: TripStatus }> {
  return dataSource.transaction(async (manager) => {
    const booking = await manager.findOne(Booking, {
      where: { id: bookingId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!booking || booking.paymentMode !== TripPaymentMode.CASH ||
        ![BookingStatus.ACCEPTED, BookingStatus.COMPLETED].includes(booking.status) ||
        !(booking.status === BookingStatus.COMPLETED || booking.droppedOff || booking.droppedOffAt) ||
        !booking.firstTripSubsidyApplied || Number(booking.zwangaSubsidyAmount) <= 0) {
      return { earning: null, created: false };
    }
    const existing = await manager.findOne(DriverEarning, { where: { bookingId } });
    // Never recreate, alter, or reactivate an existing (including cancelled) credit.
    if (existing) return { earning: existing, created: false };
    const gross = Number(booking.grossPaymentAmount);
    const passenger = Number(booking.paymentAmount);
    const subsidy = Number(booking.zwangaSubsidyAmount);
    if (booking.grossPaymentAmount == null || booking.paymentAmount == null ||
        ![gross, passenger, subsidy].every(Number.isFinite) || gross <= 0 || passenger < 0 ||
        subsidy <= 0 || Math.round(gross * 100) !== Math.round(passenger * 100) + Math.round(subsidy * 100)) {
      throw new Error(`CASH_SUBSIDY_FARE_INCONSISTENT bookingId=${bookingId}`);
    }
    const trip = await manager.findOne(Trip, { where: { id: booking.tripId } });
    if (!trip) throw new Error(`CASH_SUBSIDY_TRIP_MISSING bookingId=${bookingId}`);
    booking.trip = trip;
    // No repricing, no passenger debit, no external payout.
    const earning = await record(manager, booking);
    return { earning, created: Boolean(earning), tripStatus: trip.status };
  });
}
