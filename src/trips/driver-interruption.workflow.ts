import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { EntityManager } from 'typeorm';
import { Booking, BookingStatus } from '../bookings/entities/booking.entity';
import { BookingsService } from '../bookings/bookings.service';
import { InterruptionFareQuote } from '../bookings/interruption-fare';
import { Trip, TripStatus } from './entities/trip.entity';
import {
  DriverTripInterruptionConfirmation as Confirmation,
  DriverTripInterruptionRequest as Interruption,
  TripInterruptionConfirmationStatus as ConfirmationStatus,
  TripInterruptionStatus as Status,
} from './entities/trip-interruption.entity';
import {
  DriverInterruptionDecisionDto,
  DriverInterruptionFareQueryDto,
} from './dto/trip-interruption.dto';

/** All transitions serialize on the trip row. Route/payment services run outside transactions. */
export class DriverInterruptionWorkflow {
  constructor(
    private readonly manager: EntityManager,
    private readonly bookings: BookingsService,
  ) {}

  private async lockTrip(manager: EntityManager, tripId: string) {
    const trip = await manager.findOne(Trip, {
      where: { id: tripId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!trip) throw new NotFoundException('Trajet introuvable.');
    return trip;
  }

  async respond(
    tripId: string,
    passengerId: string,
    bookingId: string | undefined,
    confirmed: boolean,
    reason?: string,
  ) {
    return this.manager.transaction(async (manager) => {
      const trip = await this.lockTrip(manager, tripId);
      const request = await manager.findOne(Interruption, {
        where: [
          { tripId, status: Status.PENDING },
          { tripId, status: Status.CONFIRMED },
        ],
        order: { createdAt: 'DESC' },
      });
      if (!request)
        throw new NotFoundException(
          'Aucune interruption en attente de confirmation.',
        );
      const confirmations = await manager.find(Confirmation, {
        where: { requestId: request.id },
      });
      const confirmation = confirmations.find(
        (item) =>
          item.passengerId === passengerId &&
          (!bookingId || item.bookingId === bookingId),
      );
      if (!confirmation)
        throw new ForbiddenException(
          'Cette réservation ne vous appartient pas.',
        );
      const nextStatus = confirmed
        ? ConfirmationStatus.CONFIRMED
        : ConfirmationStatus.REJECTED;
      if (confirmation.status === nextStatus)
        return { request, confirmation, paused: false };
      if (
        request.status !== Status.PENDING ||
        confirmation.status !== ConfirmationStatus.PENDING ||
        trip.status !== TripStatus.ACTIVE
      ) {
        throw new BadRequestException(
          'Cette interruption a déjà été traitée. Actualisez le trajet.',
        );
      }
      confirmation.status = nextStatus;
      if (confirmed) confirmation.confirmedAt = new Date();
      else {
        confirmation.rejectedAt = new Date();
        confirmation.rejectionReason = reason ?? null;
      }
      await manager.save(Confirmation, confirmation);
      request.confirmedPassengerCount = confirmations.filter(
        (item) => item.status === ConfirmationStatus.CONFIRMED,
      ).length;
      request.rejectedPassengerCount = confirmations.filter(
        (item) => item.status === ConfirmationStatus.REJECTED,
      ).length;
      const paused =
        confirmations.length > 0 &&
        confirmations.length === request.requiredPassengerCount &&
        request.confirmedPassengerCount === confirmations.length;
      if (!confirmed) {
        request.status = Status.REJECTED;
        request.rejectedAt = new Date();
      }
      if (paused) {
        request.status = Status.CONFIRMED;
        request.confirmedAt = new Date();
        // Freeze the interruption position. Waiting never completes a booking or releases its seat.
        request.requestedLocation =
          request.requestedLocation ?? trip.currentLocation;
        trip.status = TripStatus.PENDING;
        await manager.save(Trip, trip);
      }
      await manager.save(Interruption, request);
      return { request, confirmation, paused };
    });
  }

  async cancel(tripId: string, driverId: string) {
    return this.manager.transaction(async (manager) => {
      const trip = await this.lockTrip(manager, tripId);
      if (trip.driverId !== driverId)
        throw new ForbiddenException(
          'Seul le conducteur peut annuler cette interruption.',
        );
      const request = await manager.findOne(Interruption, {
        where: { tripId, status: Status.PENDING },
      });
      if (!request)
        throw new BadRequestException(
          "Cette interruption n'est plus en attente.",
        );
      request.status = Status.CANCELLED;
      request.cancelledAt = new Date();
      return manager.save(Interruption, request);
    });
  }

  private async getPassengerContext(
    manager: EntityManager,
    tripId: string,
    passengerId: string,
    dto: DriverInterruptionFareQueryDto,
  ) {
    const request = await manager.findOne(Interruption, {
      where: { id: dto.requestId, tripId },
    });
    const confirmation = await manager
      .getRepository(Confirmation)
      .createQueryBuilder('confirmation')
      .addSelect('confirmation.fareQuote')
      .where(
        'confirmation.requestId = :requestId AND confirmation.bookingId = :bookingId AND confirmation.passengerId = :passengerId',
        { ...dto, passengerId },
      )
      .getOne();
    if (
      !request ||
      !confirmation ||
      confirmation.status !== ConfirmationStatus.CONFIRMED
    ) {
      throw new ForbiddenException(
        'Cette interruption ne concerne pas votre réservation confirmée.',
      );
    }
    return { request, confirmation };
  }

  private assertPaused(trip: Trip, request: Interruption) {
    if (
      trip.status !== TripStatus.PENDING ||
      request.status !== Status.CONFIRMED
    ) {
      throw new BadRequestException(
        "Le trajet n'est plus en pause. Actualisez pour voir son état actuel.",
      );
    }
  }

  async quote(
    tripId: string,
    passengerId: string,
    dto: DriverInterruptionFareQueryDto,
  ): Promise<InterruptionFareQuote> {
    const { request, confirmation } = await this.getPassengerContext(
      this.manager,
      tripId,
      passengerId,
      dto,
    );
    if (request.status !== Status.CONFIRMED)
      throw new BadRequestException("Le trajet n'est plus en pause.");
    if (confirmation.fareQuote) return confirmation.fareQuote;
    // Potential network I/O before taking any lock.
    const calculation = await this.bookings.quoteDriverInterruptionFare(
      dto.bookingId,
      request.requestedLocation,
    );
    return this.manager.transaction(async (manager) => {
      const trip = await this.lockTrip(manager, tripId);
      const current = await this.getPassengerContext(
        manager,
        tripId,
        passengerId,
        dto,
      );
      this.assertPaused(trip, current.request);
      if (current.confirmation.fareQuote) return current.confirmation.fareQuote;
      const quote: InterruptionFareQuote = {
        ...calculation,
        id: randomUUID(),
        requestId: dto.requestId,
        bookingId: dto.bookingId,
      };
      current.confirmation.fareQuote = quote;
      await manager.save(Confirmation, current.confirmation);
      return quote;
    });
  }

  async decide(
    tripId: string,
    passengerId: string,
    dto: DriverInterruptionDecisionDto,
  ) {
    const quote = await this.manager.transaction(async (manager) => {
      const trip = await this.lockTrip(manager, tripId);
      const { request, confirmation } = await this.getPassengerContext(
        manager,
        tripId,
        passengerId,
        dto,
      );
      // A retry must not charge twice, including after the driver has restarted.
      if (confirmation.decision === 'stop' && dto.decision === 'stop')
        return confirmation.settledAt ? null : confirmation.fareQuote;
      this.assertPaused(trip, request);
      if (confirmation.decision === 'stop')
        throw new BadRequestException(
          'Vous avez déjà terminé cette réservation.',
        );
      if (
        dto.decision === 'stop' &&
        (!confirmation.fareQuote || confirmation.fareQuote.id !== dto.quoteId)
      ) {
        throw new BadRequestException(
          'Vérifiez le montant affiché avant de confirmer votre arrêt.',
        );
      }
      const booking = await manager.findOne(Booking, {
        where: { id: dto.bookingId, passengerId, tripId },
        lock: { mode: 'pessimistic_write' },
      });
      if (
        !booking ||
        booking.status !== BookingStatus.ACCEPTED ||
        booking.droppedOff ||
        booking.droppedOffConfirmedByPassenger ||
        !(booking.pickedUp || booking.pickedUpConfirmedByPassenger)
      ) {
        throw new BadRequestException(
          "Cette réservation n'est plus en cours. Actualisez le trajet.",
        );
      }
      confirmation.decision = dto.decision;
      confirmation.decisionAt = new Date();
      if (dto.decision === 'stop') {
        await this.bookings.applyDriverInterruptionFare(
          booking,
          confirmation.fareQuote!,
          manager,
        );
        trip.availableSeats = Math.min(
          trip.totalSeats ?? trip.availableSeats + booking.numberOfSeats,
          trip.availableSeats + booking.numberOfSeats,
        );
        await manager.save(Trip, trip);
      }
      await manager.save(Confirmation, confirmation);
      return dto.decision === 'stop' ? confirmation.fareQuote : null;
    });
    if (quote) await this.settleQuote(quote);
    return {
      bookingId: dto.bookingId,
      requestId: dto.requestId,
      decision: dto.decision,
    };
  }

  async resume(tripId: string, driverId: string): Promise<boolean> {
    return this.manager.transaction(async (manager) => {
      const trip = await this.lockTrip(manager, tripId);
      const request = await manager.findOne(Interruption, {
        where: { tripId, status: Status.CONFIRMED },
      });
      if (!request) return false;
      if (trip.driverId !== driverId)
        throw new ForbiddenException(
          'Seul le conducteur peut redémarrer ce trajet.',
        );
      this.assertPaused(trip, request);
      const confirmations = await manager.find(Confirmation, {
        where: { requestId: request.id },
      });
      if (confirmations.some((item) => !item.decision))
        throw new BadRequestException(
          "Attendez que chaque passager choisisse de continuer ou de s'arrêter avant de redémarrer.",
        );
      request.status = Status.COMPLETED;
      request.completedAt = new Date();
      trip.status = TripStatus.ACTIVE;
      // Keep the original start, pickup flags, agreed prices and current position on resume.
      await manager.save(Interruption, request);
      await manager.save(Trip, trip);
      return true;
    });
  }

  private async settleQuote(quote: InterruptionFareQuote) {
    await this.bookings.settleDriverInterruptionFare(
      quote.bookingId,
      quote.prepaidAmount,
    );
    await this.manager.update(
      Confirmation,
      {
        requestId: quote.requestId,
        bookingId: quote.bookingId,
        decision: 'stop',
      },
      { settledAt: new Date() },
    );
  }

  /** Retry committed decisions after a transient payment/cache failure or a process restart. */
  async retryPendingSettlements(onError: (error: unknown) => void) {
    const pending = await this.manager
      .getRepository(Confirmation)
      .createQueryBuilder('confirmation')
      .addSelect('confirmation.fareQuote')
      .where(
        "confirmation.decision = 'stop' AND confirmation.settledAt IS NULL",
      )
      .orderBy('confirmation.decisionAt', 'ASC')
      .take(25)
      .getMany();
    for (const confirmation of pending) {
      if (!confirmation.fareQuote) continue;
      try {
        await this.settleQuote(confirmation.fareQuote);
      } catch (error) {
        onError(error);
      }
    }
  }
}
