import { BadRequestException, ConflictException } from '@nestjs/common';
import { Booking, BookingPaymentStatus } from './entities/booking.entity';
import { Trip } from '../trips/entities/trip.entity';
import { assertMinimumTripPrice } from '../trip-requests/trip-request-pricing';

/** A proposal is not a payment nor a change to the public trip price. CDF integers. */
export function validateBookingPriceProposal(value: unknown, trip: Trip, seats: number): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 ||
      value > 99_999_999 || !Number.isSafeInteger(seats) || seats < 1 ||
      value * seats > 99_999_999 || trip.isFree || trip.tripRequestId ||
      !Number.isFinite(Number(trip.pricePerSeat)) || value >= Number(trip.pricePerSeat)) {
    throw new BadRequestException('Proposez un montant entier en FC, supérieur à zéro et inférieur au prix par place affiché.');
  }
  assertMinimumTripPrice(value);
  return value;
}

/** All acceptance endpoints require explicit consent, including older native actions. */
export function acceptedBookingProposalTotal(booking: Booking, acknowledged?: number): number | null {
  if (booking.proposedPricePerSeat == null) return null;
  const price = Number(booking.proposedPricePerSeat);
  if (!Number.isSafeInteger(price) || price < 1 || acknowledged !== price ||
      !Number.isSafeInteger(booking.numberOfSeats) || booking.numberOfSeats < 1 ||
      price * booking.numberOfSeats > 99_999_999) {
    throw new ConflictException({ code: 'BOOKING_PRICE_CONFIRMATION_REQUIRED',
      message: 'Ce passager propose un autre prix. Ouvrez la réservation dans la dernière version de Zwanga pour voir et accepter ce montant.' });
  }
  if (booking.paidAt || booking.cashReceivedAt || booking.mixedPaymentAt || booking.paymentTransactionId ||
      booking.paymentReference || booking.fareAdjustedAt || booking.interruptionFareLocked ||
      [BookingPaymentStatus.INITIATED, BookingPaymentStatus.SUCCEEDED].includes(booking.paymentStatus)) {
    throw new ConflictException('Un règlement est déjà engagé. Le prix de cette réservation ne peut plus changer.');
  }
  return price * booking.numberOfSeats;
}
