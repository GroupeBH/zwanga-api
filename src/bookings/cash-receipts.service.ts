import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  Booking,
  BookingStatus,
  BookingPaymentStatus,
} from './entities/booking.entity';
import { Trip } from '../trips/entities/trip.entity';
import { User } from '../users/entities/user.entity';
import { BookingsService } from './bookings.service';
import { TripPaymentMode } from '../payments/enums/trip-payment-mode.enum';
import {
  displayAmount,
  enqueueTransactionalNotification,
} from '../notifications/transactional-notification';

@Injectable()
export class CashReceiptsService {
  constructor(
    @InjectRepository(Booking) private readonly repository: Repository<Booking>,
    private readonly bookings: BookingsService,
  ) {}

  /** Passenger intent is durable, but never writes a receipt or moves money. */
  async declare(
    id: string,
    passengerId: string,
    amount: number,
    currency: string,
  ): Promise<Booking> {
    await this.repository.manager.transaction(async (manager) => {
      const booking = await manager.findOne(Booking, {
        where: { id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!booking) throw new NotFoundException('Réservation non trouvée.');
      if (booking.passengerId !== passengerId)
        throw new ForbiddenException(
          'Seul le passager peut déclarer son paiement cash.',
        );
      if (
        booking.status !== BookingStatus.COMPLETED ||
        !booking.droppedOff ||
        booking.paymentMode !== TripPaymentMode.CASH ||
        booking.paymentStatus !== BookingPaymentStatus.NOT_REQUIRED
      ) {
        throw new BadRequestException(
          'Le paiement cash peut être déclaré après l’arrivée, pour une réservation à régler en cash.',
        );
      }
      if (
        !Number.isFinite(amount) ||
        amount <= 0 ||
        !['CDF', 'USD'].includes(currency) ||
        Number(booking.paymentAmount) !== amount ||
        booking.paymentCurrency !== currency
      ) {
        throw new ConflictException(
          'Le montant a changé. Actualisez le paiement avant de confirmer.',
        );
      }
      if (booking.cashReceivedAt) return;
      const trip = await manager.findOneBy(Trip, { id: booking.tripId });
      if (!trip || trip.driverId === passengerId)
        throw new BadRequestException('Trajet invalide.');
      const passenger = await manager.findOne(User, {
        where: { id: passengerId },
        select: ['id', 'firstName', 'lastName'],
      });
      const passengerName =
        [passenger?.firstName, passenger?.lastName]
          .filter(Boolean)
          .join(' ')
          .trim()
          .slice(0, 100) || 'Le passager';
      await enqueueTransactionalNotification(manager, {
        eventKey: `cash-declaration:${id}:${amount}:${currency}`,
        userId: trip.driverId,
        title: 'Cash à confirmer',
        body: `${passengerName} indique avoir payé ${displayAmount(amount, currency)} en cash. Confirmez uniquement après avoir reçu l’argent.`,
        data: {
          type: 'cash_payment_declared',
          role: 'driver',
          driverId: trip.driverId,
          bookingId: id,
          tripId: booking.tripId,
          paymentMode: 'cash',
          amount,
          currency,
          passengerName,
        },
      });
    });
    return this.bookings.findOne(id);
  }

  async confirm(
    id: string,
    driverId: string,
    amount: number,
    currency: string,
  ): Promise<Booking> {
    const booking = await this.repository.findOne({
      where: { id },
      relations: ['trip'],
    });
    if (!booking) throw new NotFoundException('Réservation non trouvée.');
    if (booking.trip?.driverId !== driverId)
      throw new ForbiddenException(
        'Seul le conducteur de ce trajet peut confirmer le cash reçu.',
      );
    if (
      booking.paymentMode !== TripPaymentMode.CASH ||
      booking.status !== BookingStatus.COMPLETED ||
      !booking.droppedOff
    ) {
      throw new BadRequestException(
        'La réception du cash peut être confirmée après l’arrivée à destination, pour une réservation payée en cash.',
      );
    }
    if (
      !Number.isFinite(amount) ||
      amount <= 0 ||
      Number(booking.paymentAmount) !== amount ||
      booking.paymentCurrency !== currency
    )
      throw new ConflictException(
        'Le montant a changé. Actualisez le trajet avant de confirmer le cash reçu.',
      );
    // A single conditional statement rechecks ownership, fare and mode under PostgreSQL's row lock.
    // COALESCE preserves the original receipt on retries/double taps, including concurrent retries.
    await this.repository.manager.transaction(async (manager) => {
      const rows = await manager.query<
        [{ id: string; passengerId: string }[], number]
      >(
        `UPDATE bookings AS b SET
      "cashReceivedAt" = COALESCE(b."cashReceivedAt", CURRENT_TIMESTAMP),
      "cashReceivedByDriverId" = COALESCE(b."cashReceivedByDriverId", $2::uuid),
      "cashReceivedAmount" = COALESCE(b."cashReceivedAmount", b."paymentAmount"),
      "updatedAt" = CURRENT_TIMESTAMP
      FROM trips AS t WHERE b.id = $1::uuid AND t.id = b."tripId" AND t."driverId" = $2::uuid
        AND b.status = 'completed' AND b."droppedOff" = true AND b."paymentMode" = 'cash'
        AND b."paymentStatus" = 'not_required' AND b."paymentAmount" = $3 AND b."paymentCurrency" = $4
      RETURNING b.id, b."passengerId"`,
        [id, driverId, amount, currency],
      );
      // TypeORM's PostgreSQL raw UPDATE returns [rows, affectedCount].
      if (!rows?.[0]?.length)
        throw new ConflictException(
          'La réservation a changé. Actualisez le trajet puis réessayez.',
        );
      const passengerId = rows[0][0].passengerId;
      for (const recipient of [
        {
          userId: passengerId,
          role: 'passenger',
          title: 'Paiement cash confirmé',
          body: `Le conducteur a confirmé la réception de votre paiement de ${displayAmount(amount, currency)}.`,
        },
        {
          userId: driverId,
          role: 'driver',
          title: 'Cash reçu enregistré',
          body: `Votre encaissement de ${displayAmount(amount, currency)} a été enregistré. Aucun versement électronique supplémentaire n’est prévu pour ce paiement cash.`,
        },
      ]) {
        await enqueueTransactionalNotification(manager, {
          eventKey: `cash-receipt:${id}:${recipient.userId}`,
          userId: recipient.userId,
          title: recipient.title,
          body: recipient.body,
          data: {
            type: 'cash_payment_confirmed',
            bookingId: id,
            tripId: booking.tripId,
            driverId,
            paymentMode: 'cash',
            receiptKey: `booking-payment:${id}:cash`,
            amount,
            currency,
            role: recipient.role,
          },
        });
      }
    });
    await this.bookings.invalidateManualRideCaches(id);
    // Deliberately NO settlement, transfer, subsidy, wallet credit or external payment call.
    return this.bookings.findOne(id);
  }
}
