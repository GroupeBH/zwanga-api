import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, In } from 'typeorm';
import {
  Booking,
  BookingPaymentStatus,
  BookingStatus,
} from './entities/booking.entity';
import { Trip } from '../trips/entities/trip.entity';
import { TripPaymentMode } from '../payments/enums/trip-payment-mode.enum';
import {
  PaymentPurpose,
  PaymentStatus,
  PaymentTransaction,
} from '../payments/entities/payment-transaction.entity';
import { WalletService } from '../wallet/wallet.service';
import { DriverSettlementsService } from '../driver-settlements/driver-settlements.service';
import { BookingsService } from './bookings.service';
import { MixedCashPaymentDto } from './dto/mixed-cash-payment.dto';
import {
  displayAmount,
  enqueueTransactionalNotification,
} from '../notifications/transactional-notification';

const round = (value: number) => Math.round(value * 100) / 100;

@Injectable()
export class MixedCashPaymentService {
  constructor(
    private readonly db: DataSource,
    private readonly wallet: WalletService,
    private readonly settlements: DriverSettlementsService,
    private readonly bookings: BookingsService,
  ) {}

  async pay(
    id: string,
    passengerId: string,
    dto: MixedCashPaymentDto,
  ): Promise<Booking> {
    const result = await this.db.transaction(async (manager) => {
      const booking = await manager.findOne(Booking, {
        where: { id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!booking) throw new NotFoundException('Réservation introuvable.');
      if (booking.passengerId !== passengerId) throw new ForbiddenException();
      const trip = await manager.findOne(Trip, {
        where: { id: booking.tripId },
      });
      if (!trip || trip.driverId === passengerId)
        throw new BadRequestException('Trajet invalide.');
      booking.trip = trip;
      if (booking.tokenCashFallbackAt) throw new ConflictException('Le paiement en espèces a déjà été choisi pour ce trajet.');
      if (booking.mixedPaymentAt) {
        if (
          Number(booking.mixedTokenQuantity) !== dto.tokenQuantity ||
          Number(booking.mixedTokenAmount) !== dto.expectedTokenAmount ||
          round(
            Number(booking.paymentAmount) + Number(booking.mixedTokenAmount),
          ) !== dto.expectedAmount ||
          booking.paymentCurrency !== dto.currency
        )
          throw new ConflictException(
            'Un règlement mixte est déjà enregistré. Actualisez le trajet.',
          );
        return booking; // Also after cash receipt: retry is a read, never a second debit.
      }
      if (
        booking.status !== BookingStatus.COMPLETED ||
        !booking.droppedOff ||
        booking.cashReceivedAt ||
        booking.paymentStatus === BookingPaymentStatus.SUCCEEDED
      )
        throw new BadRequestException(
          'Le complément en espèces est disponible après l’arrivée, avant tout paiement confirmé.',
        );
      const accepted = trip.acceptedPaymentModes ?? [];
      if (
        !accepted.includes(TripPaymentMode.CASH) ||
        !accepted.includes(TripPaymentMode.POINTS)
      )
        throw new BadRequestException(
          'Ce trajet doit accepter les jetons et les espèces.',
        );
      const amount = Number(booking.paymentAmount),
        rate = Number(booking.cashCommissionTokenValue);
      const covered = round(dto.tokenQuantity * rate);
      if (
        dto.currency !== 'CDF' ||
        booking.paymentCurrency !== dto.currency ||
        amount !== dto.expectedAmount ||
        covered !== dto.expectedTokenAmount ||
        ![amount, rate, dto.tokenQuantity, covered].every(Number.isFinite) ||
        rate <= 0 ||
        dto.tokenQuantity <= 0 ||
        round(dto.tokenQuantity) !== dto.tokenQuantity ||
        covered <= 0 ||
        covered >= amount ||
        round(covered / rate) !== dto.tokenQuantity
      )
        throw new ConflictException(
          'Le montant ou le tarif des jetons a changé. Actualisez avant de payer.',
        );
      // A terminal refusal is not a live collection. Keep unresolved and paid
      // transactions blocking; do not strand the user after a confirmed failure.
      if (
        await manager.exists(PaymentTransaction, {
          where: [
            {
              purpose: PaymentPurpose.TRIP_BOOKING,
              relatedEntityType: 'booking',
              relatedEntityId: id,
              status: In([PaymentStatus.PENDING, PaymentStatus.INITIATED, PaymentStatus.SUCCEEDED]),
            },
            {
              purpose: PaymentPurpose.WALLET_TOP_UP,
              userId: passengerId,
              status: In([PaymentStatus.PENDING, PaymentStatus.INITIATED]),
            },
          ],
        })
      )
        throw new ConflictException(
          'Un paiement Mobile Money doit être vérifié avant de choisir les espèces.',
        );

      // Deterministic lock order for rides where both parties have wallets. No network calls in this transaction.
      const owners = [passengerId, trip.driverId].sort();
      await manager.query(
        'SELECT id FROM users WHERE id = ANY($1::uuid[]) ORDER BY id FOR KEY SHARE',
        [owners],
      );
      await manager.query(
        'SELECT id FROM wallet_accounts WHERE "userId" = ANY($1::uuid[]) AND type = \'points\' ORDER BY "userId" FOR UPDATE',
        [owners],
      );
      const before = { ...booking };
      await this.wallet.payForBookingWithManager(manager, booking, covered);
      booking.paymentMode = TripPaymentMode.CASH;
      booking.paymentStatus = BookingPaymentStatus.NOT_REQUIRED;
      booking.mixedTokenAmount = covered;
      booking.mixedTokenQuantity = dto.tokenQuantity;
      booking.mixedPaymentAt = new Date();
      // Legacy clients and the unchanged cash commission/receipt rules see only
      // the amount still to collect. Original passenger fare = cash + token portion.
      booking.paymentAmount = round(amount - covered);
      await manager.save(booking);
      await this.settlements.recordMixedCashEarningWithManager(
        manager,
        before,
        booking,
      );
      await enqueueTransactionalNotification(manager, {
        eventKey: `mixed-cash:${id}`,
        userId: trip.driverId,
        title: 'Paiement jetons + espèces',
        body: `${displayAmount(covered, dto.currency)} réglés en jetons. Reste à recevoir en espèces : ${displayAmount(round(amount - covered), dto.currency)}.`,
        data: {
          type: 'booking_mixed_payment',
          bookingId: id,
          tripId: trip.id,
          role: 'driver',
        },
      });
      return booking;
    });
    // The authoritative response must survive a cache outage after a successful commit.
    await this.bookings.invalidateManualRideCaches(id).catch(() => undefined);
    return result;
  }
}
