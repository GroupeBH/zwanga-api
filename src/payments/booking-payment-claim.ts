import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { In, Repository } from 'typeorm';
import {
  Booking,
  BookingPaymentStatus,
  BookingStatus,
} from '../bookings/entities/booking.entity';
import { TripPaymentMode } from './enums/trip-payment-mode.enum';
import {
  PaymentPurpose,
  PaymentStatus,
  PaymentTransaction,
} from './entities/payment-transaction.entity';

/** Durable booking-scoped claim. Commit before HTTP; a lost reply never permits a second send. */
export async function claimBookingPayment(
  repository: Repository<PaymentTransaction>,
  candidate: PaymentTransaction,
) {
  if (
    candidate.relatedEntityType !== 'booking' ||
    !candidate.relatedEntityId ||
    !candidate.userId
  ) {
    throw new BadRequestException('Réservation requise pour ce paiement');
  }
  return repository.manager.transaction(async (manager) => {
    const booking = await manager.findOne(Booking, {
      where: { id: candidate.relatedEntityId! },
      lock: { mode: 'pessimistic_write' },
    });
    if (!booking) throw new NotFoundException('Réservation non trouvée');
    if (booking.passengerId !== candidate.userId)
      throw new BadRequestException(
        'Ce paiement ne correspond pas au passager',
      );
    const payments = manager.getRepository(PaymentTransaction);
    const scope = {
      purpose: PaymentPurpose.TRIP_BOOKING,
      relatedEntityType: 'booking',
      relatedEntityId: booking.id,
    };
    // Include historical attempts, regardless of the method/phone/provider of this retry.
    const existing =
      (await payments.findOne({
        where: { ...scope, status: PaymentStatus.SUCCEEDED },
        order: { createdAt: 'ASC', id: 'ASC' },
      })) ??
      (await payments.findOne({
        where: {
          ...scope,
          status: In([PaymentStatus.PENDING, PaymentStatus.INITIATED]),
        },
        order: { createdAt: 'DESC', id: 'DESC' },
      }));
    if (existing) return { payment: existing, created: false };
    if (
      booking.paymentMode !== TripPaymentMode.ELECTRONIC ||
      booking.paymentStatus === BookingPaymentStatus.SUCCEEDED ||
      booking.mixedPaymentAt ||
      booking.tokenCashFallbackAt ||
      booking.cashReceivedAt ||
      ![BookingStatus.ACCEPTED, BookingStatus.COMPLETED].includes(
        booking.status,
      )
    ) {
      throw new ConflictException(
        'Cette réservation ne peut plus recevoir un nouveau paiement électronique',
      );
    }
    if (
      Math.round(Number(booking.paymentAmount) * 100) !==
        Math.round(Number(candidate.amount) * 100) ||
      booking.paymentCurrency !== candidate.currency
    ) {
      throw new ConflictException(
        'Le montant de la réservation a changé. Actualisez le paiement.',
      );
    }
    const payment = await payments.save(candidate);
    await manager.update(Booking, booking.id, {
      paymentTransactionId: payment.id,
      paymentReference: payment.reference,
      paymentStatus: BookingPaymentStatus.PENDING,
    });
    return { payment, created: true };
  });
}
