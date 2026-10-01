import type { Repository } from 'typeorm';
import type { Booking } from '../bookings/entities/booking.entity';
import { TripPaymentMode } from '../payments/enums/trip-payment-mode.enum';

/** Informational receipts only: do not use this total to credit earnings or pay out. */
export async function sumConfirmedDriverCash(
  bookings: Repository<Booking>,
  driverId: string,
  currency: string,
): Promise<number> {
  const result = await bookings
    .createQueryBuilder('booking')
    .innerJoin('booking.trip', 'trip')
    .select('COALESCE(SUM(booking.cashReceivedAmount), 0)', 'sum')
    .where('trip.driverId = :driverId', { driverId })
    .andWhere('booking.cashReceivedByDriverId = :driverId', { driverId })
    .andWhere('booking.paymentMode = :paymentMode', {
      paymentMode: TripPaymentMode.CASH,
    })
    .andWhere('booking.paymentCurrency = :currency', { currency })
    .andWhere('booking.cashReceivedAt IS NOT NULL')
    .getRawOne<{ sum: string }>();

  return Math.round(Number(result?.sum ?? 0) * 100) / 100;
}
