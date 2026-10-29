import type { EntityManager } from 'typeorm';
import { Booking, BookingPaymentStatus } from '../bookings/entities/booking.entity';
import { Trip } from '../trips/entities/trip.entity';
import { TripPaymentMode } from '../payments/enums/trip-payment-mode.enum';
import { displayAmount, enqueueTransactionalNotification, type TransactionalNotification } from './transactional-notification';

export const DRIVER_PAYMENT_NOTIFICATION_TYPE = 'driver_booking_payment_confirmed';

/** A committed receipt, not a promise of settlement or a gross driver earning. */
export function driverPaymentNotification(booking: Booking, driverId: string, previous?: Partial<Booking>): TransactionalNotification | null {
  const electronic = [TripPaymentMode.POINTS, TripPaymentMode.ELECTRONIC].includes(booking.paymentMode);
  const paid = electronic && booking.paymentStatus === BookingPaymentStatus.SUCCEEDED &&
    previous?.paymentStatus !== BookingPaymentStatus.SUCCEEDED;
  const split = booking.paymentMode === TripPaymentMode.CASH && !!booking.mixedPaymentAt &&
    Number(booking.mixedTokenAmount) > 0 && !previous?.mixedPaymentAt;
  if ((!paid && !split) || !driverId || !booking.tripId || !booking.id) return null;
  const amount = Number(split ? booking.mixedTokenAmount : booking.paymentAmount);
  const currency = booking.paymentCurrency;
  if (!Number.isFinite(amount) || amount <= 0 || !currency || !/^[A-Z]{3}$/.test(currency)) return null;
  const cashRemainder = split ? Number(booking.paymentAmount) : 0;
  if (!Number.isFinite(cashRemainder) || cashRemainder < 0) return null;
  const mode = split ? TripPaymentMode.POINTS : booking.paymentMode;
  return {
    eventKey: `driver-payment:${booking.id}:${split ? 'tokens' : 'paid'}`,
    userId: driverId, title: split ? 'Paiement partiel reçu' : 'Paiement reçu',
    body: `${displayAmount(amount, currency)} reçus ${mode === TripPaymentMode.POINTS ? 'en jetons Zwanga' : 'par paiement électronique'}.${split ? ` Il reste ${displayAmount(cashRemainder, currency)} à recevoir en espèces.` : ''}`,
    data: { type: DRIVER_PAYMENT_NOTIFICATION_TYPE, role: 'driver', driverId,
      bookingId: booking.id, tripId: booking.tripId, amount, currency, paymentMode: mode,
      receiptKey: split ? `booking-payment:${booking.id}:tokens` : `booking-payment:${booking.id}`,
      cashRemainder, partial: split },
  };
}

export async function enqueueDriverPayment(manager: EntityManager, booking: Booking, previous?: Partial<Booking>) {
  // No extra read for the frequent GPS/boarding/status-only saves.
  if (!(booking.paymentStatus === BookingPaymentStatus.SUCCEEDED && previous?.paymentStatus !== BookingPaymentStatus.SUCCEEDED) &&
      !(booking.mixedPaymentAt && !previous?.mixedPaymentAt)) return;
  const trip = await manager.findOneBy(Trip, { id: booking.tripId });
  const notice = trip && driverPaymentNotification(booking, trip.driverId, previous);
  if (notice) await enqueueTransactionalNotification(manager, notice);
}
