import { ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { ArrivalAssistanceService } from '../bookings/arrival-assistance.service';
import { arrivalObservationMatchesTrip, canAcceptArrivalPrompt } from '../bookings/arrival-assistance.policy';
import { Cron } from '@nestjs/schedule';
import { DataSource, LessThanOrEqual, Raw, Equal } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { Booking, BookingStatus } from '../bookings/entities/booking.entity';
import { BookingsService } from '../bookings/bookings.service';
import { Trip, TripStatus } from '../trips/entities/trip.entity';
import { RideDeclarationDto } from './ride-declaration.dto';
import { dropoffDeclarationStatus, pickupDeclarationStatus, hasRideDispute } from './ride-declaration.model';
import { recordDeclaration } from './ride-declaration.policy';
import { assertPassengerCanConfirmRide, rideConfirmationMode } from './ride-confirmation-mode';

@Injectable()
export class RideDeclarationsService {
  private readonly logger = new Logger(RideDeclarationsService.name);
  private repairing = false;
  constructor(private readonly db: DataSource, private readonly bookings: BookingsService,
    @Optional() private readonly arrivalAssistance?: ArrivalAssistanceService) {}

  private view(booking: Booking, trip: Trip, userId: string) {
    const { driverId } = trip;
    if (booking.passengerId !== userId && driverId !== userId) throw new ForbiddenException('Cette réservation ne vous appartient pas.');
    const declarations = booking.rideDeclarations ?? {};
    const confirmationMode = rideConfirmationMode(trip);
    return {
      bookingId: booking.id,
      tripId: booking.tripId,
      actor: driverId === userId ? 'driver' : 'passenger',
      confirmationMode,
      arrivalAssistance: booking.arrivalPrompt ? {
        id: booking.arrivalPrompt.id, expiresAt: booking.arrivalPrompt.expiresAt,
        canAccept: canAcceptArrivalPrompt(booking, trip, Date.now()) && !hasRideDispute(declarations),
      } : undefined,
      pickup: { status: pickupDeclarationStatus(declarations.pickup, Boolean(booking.pickedUp || booking.pickedUpAt), confirmationMode), driver: declarations.pickup?.driver?.decision, passenger: declarations.pickup?.passenger?.decision },
      dropoff: { status: dropoffDeclarationStatus(declarations.dropoff, Boolean(booking.droppedOff || booking.droppedOffAt), confirmationMode), driver: declarations.dropoff?.driver?.decision, passenger: declarations.dropoff?.passenger?.decision },
    };
  }

  async get(bookingId: string, userId: string) {
    const booking = await this.db.getRepository(Booking).createQueryBuilder('b')
      .addSelect('b.rideDeclarations').innerJoinAndSelect('b.trip', 'trip')
      .where('b.id = :bookingId', { bookingId }).getOne();
    if (!booking) throw new NotFoundException('Réservation introuvable.');
    return this.view(booking, booking.trip, userId);
  }

  async getForTrip(tripId: string, userId: string) {
    const trip = await this.db.getRepository(Trip).findOneBy({ id: tripId, driverId: userId });
    if (!trip) throw new NotFoundException('Trajet introuvable.');
    const bookings = await this.db.getRepository(Booking).createQueryBuilder('b')
      .addSelect('b.rideDeclarations').where('b.tripId = :tripId', { tripId }).getMany();
    return bookings.map(booking => this.view(booking, trip, userId));
  }

  async declare(bookingId: string, userId: string, dto: RideDeclarationDto, expectedActor?: 'driver' | 'passenger') {
    if (dto.actorUserId !== userId) throw new ForbiddenException({ code: 'RIDE_ACCOUNT_CHANGED', message: 'Le compte a changé. Reconnectez-vous au compte utilisé pour cette confirmation.' });
    const reference = await this.db.getRepository(Booking).findOneBy({ id: bookingId });
    if (!reference) throw new NotFoundException('Réservation introuvable.');
    // Redis I/O stays outside the SQL transaction. Recheck against the locked trip GPS.
    const arrivalObservation = dto.arrivalPromptId && reference.passengerId === userId
      ? await this.arrivalAssistance?.latestObservation(reference.tripId) : undefined;
    const result = await this.db.transaction(async manager => {
      // Same lock order as trip interruption: trip, then booking. No network I/O.
      const trip = await manager.findOne(Trip, { where: { id: reference.tripId }, lock: { mode: 'pessimistic_write' } });
      const booking = await manager.getRepository(Booking).createQueryBuilder('b').addSelect(['b.rideDeclarations', 'b.rideEffectsPending'])
        .where('b.id = :bookingId', { bookingId }).setLock('pessimistic_write').getOne();
      if (!trip || !booking) throw new NotFoundException('Réservation introuvable.');
      this.view(booking, trip, userId); // Authorization also applies to replays.
      const actor = trip.driverId === userId ? 'driver' as const : 'passenger' as const;
      if (expectedActor && actor !== expectedActor) throw new ForbiddenException('Vous ne pouvez pas confirmer à la place de l’autre personne.');
      // Reject old-client confirmations before replay handling, without erasing disputes.
      const applied = dto.stage === 'pickup' ? Boolean(booking.pickedUp || booking.pickedUpAt) : Boolean(booking.droppedOff || booking.droppedOffAt);
      const now = new Date();
      if (dto.arrivalPromptId) {
        if (actor !== 'passenger' || dto.stage !== 'dropoff' || dto.decision !== 'confirm' || dto.arrivalPromptId !== booking.arrivalPrompt?.id ||
            (!applied && (!canAcceptArrivalPrompt(booking, trip, now.getTime()) || hasRideDispute(booking.rideDeclarations) || !arrivalObservationMatchesTrip(arrivalObservation, trip, now.getTime())))) {
          throw new ConflictException({ code: 'RIDE_ARRIVAL_PROMPT_UNAVAILABLE', message: 'Cette proposition de dépose n’est plus disponible. Actualisez le trajet ; le conducteur peut confirmer la dépose réelle.' });
        }
        if (!applied && booking.rideDeclarations?.dropoff?.passenger && booking.rideDeclarations.dropoff.passenger.arrivalPromptId !== dto.arrivalPromptId) {
          throw new ConflictException({ code: 'RIDE_DECISION_LOCKED', message: 'Une réponse est déjà enregistrée pour cette arrivée. Le conducteur ou l’assistance doit vérifier cette étape.' });
        }
      } else if (actor === 'passenger' && dto.decision === 'confirm') assertPassengerCanConfirmRide(trip);
      const mode = dto.arrivalPromptId ? 'shared' : rideConfirmationMode(trip);
      const change = recordDeclaration(booking.rideDeclarations, dto.stage, actor, { ...dto, receivedAt: now.toISOString() }, applied, mode);
      if (!change.changed && !change.ready) return this.view(booking, trip, userId);
      // Replaying ready receipts must not refresh their original evidence timestamps.
      const evidenceTimes = [change.declarations[dto.stage]?.[actor]?.occurredAt ?? dto.occurredAt];
      // A fresh driver tap must not promote an expired historical passenger receipt.
      if (dto.stage === 'dropoff' && change.ready && mode === 'shared') evidenceTimes.push(change.declarations.dropoff!.passenger!.occurredAt);
      for (const timestamp of evidenceTimes) {
        const occurredAt = Date.parse(timestamp);
        if (!Number.isFinite(occurredAt) || occurredAt > now.getTime() + 5 * 60_000 || occurredAt < now.getTime() - 72 * 60 * 60_000) {
          throw new ConflictException({ code: 'RIDE_EVENT_TIME', message: 'La date de cette confirmation ne permet pas de la valider. Vérifiez l’heure du téléphone ou contactez l’assistance.' });
        }
        if (trip.startedAt && occurredAt < new Date(trip.startedAt).getTime() - 5 * 60_000) {
          throw new ConflictException({ code: 'RIDE_EVENT_TIME', message: 'Cette confirmation précède le démarrage du trajet. Vérifiez l’heure de votre téléphone.' });
        }
      }
      if (trip.status !== TripStatus.ACTIVE || booking.status !== BookingStatus.ACCEPTED) {
        throw new ConflictException({ code: 'RIDE_STATE_CHANGED', message: 'Le trajet a changé depuis votre action. Actualisez son détail avant de continuer.' });
      }
      if (dto.stage === 'dropoff' && !(booking.pickedUp || booking.pickedUpAt)) {
        throw new ConflictException({ code: 'RIDE_PICKUP_REQUIRED', message: 'L’embarquement doit être validé avant de confirmer l’arrivée.' });
      }
      if (dto.stage === 'pickup' && dto.decision === 'confirm') {
        await this.bookings.validateManualRidePassenger(trip, booking.passengerId, manager);
      }
      booking.rideDeclarations = change.declarations;
      const patch: QueryDeepPartialEntity<Booking> = {
        rideDeclarations: change.declarations,
        rideEffectsPending: [...new Set([...(booking.rideEffectsPending ?? []), dto.stage])],
        rideEffectsVersion: () => '"rideEffectsVersion" + 1',
        // Do not release another worker's unexpired lease when new work arrives.
        rideEffectsRetryAt: () => 'GREATEST(COALESCE("rideEffectsRetryAt", CURRENT_TIMESTAMP), CURRENT_TIMESTAMP)',
      };
      if (change.ready && !hasRideDispute(change.declarations)) {
        Object.assign(patch, dto.stage === 'pickup' ? {
          status: BookingStatus.ACCEPTED, pickedUp: true, pickedUpAt: now,
          ...(mode === 'shared' ? { pickedUpConfirmedByPassenger: true, pickedUpConfirmedAt: now } : {}),
          pickupDetectionMethod: mode === 'driver_only' ? 'manual_driver_confirmation' : 'manual_dual_confirmation',
        } : {
          status: BookingStatus.COMPLETED, droppedOff: true, droppedOffAt: now,
          ...(mode === 'shared' ? { droppedOffConfirmedByPassenger: true, droppedOffConfirmedAt: now } : {}),
          dropoffDetectionMethod: dto.arrivalPromptId ? 'manual_passenger_near_destination' : mode === 'driver_only' ? 'manual_driver_confirmation' : change.declarations.dropoff?.driver?.decision === 'confirm'
            ? 'manual_dual_confirmation' : 'manual_passenger_confirmation',
        });
      }
      await manager.update(Booking, bookingId, patch);
      if (dto.arrivalPromptId && patch.droppedOff === true) {
        booking.arrivalPrompt = { ...booking.arrivalPrompt!, acceptedAt: now.toISOString() };
        await manager.query('UPDATE bookings SET "arrivalPrompt"=$2::jsonb WHERE id=$1', [booking.id, JSON.stringify(booking.arrivalPrompt)]);
      }
      Object.assign(booking, patch);
      return this.view(booking, trip, userId);
    });
    await this.bookings.invalidateManualRideCaches(bookingId).catch(() => {
      this.logger.warn(`Ride declaration committed; cache refresh pending for booking ${bookingId}`);
    });
    // The periodic worker owns side effects; responding never waits for SMS/payment services.
    return result;
  }

  @Cron('*/30 * * * * *')
  async repairEffects() {
    if (this.repairing) return;
    this.repairing = true;
    try {
      const repository = this.db.getRepository(Booking);
      const candidates = await repository.find({
        select: { id: true, rideEffectsPending: true, rideEffectsRetryAt: true },
        where: { rideEffectsPending: Raw(column => `jsonb_array_length(${column}) > 0`), rideEffectsRetryAt: LessThanOrEqual(new Date()) },
        order: { rideEffectsRetryAt: 'ASC' }, take: 20,
      });
      for (const candidate of candidates) {
        if (!candidate.rideEffectsPending?.length) continue;
        const leaseUntil = new Date(Date.now() + 120_000);
        const claim = await repository.update({ id: candidate.id, rideEffectsPending: Raw(column => `jsonb_array_length(${column}) > 0`), rideEffectsRetryAt: LessThanOrEqual(new Date()) },
          { rideEffectsRetryAt: leaseUntil });
        if (claim.affected !== 1) continue;
        try {
          // Read AFTER claiming: the list may have changed since the batch query.
          const claimed = await repository.findOne({
            select: { id: true, rideEffectsVersion: true, rideEffectsPending: true },
            where: { id: candidate.id, rideEffectsRetryAt: Equal(leaseUntil) },
          });
          if (!claimed) continue;
          for (const stage of claimed.rideEffectsPending) await this.bookings.finishManualRideEffects(candidate.id, stage);
          // A second declaration may have scheduled new work while we sent a
          // notification. Never clear that newer work with an old worker lease.
          const cleared = await repository.update({ id: candidate.id, rideEffectsVersion: claimed.rideEffectsVersion, rideEffectsRetryAt: Equal(leaseUntil) }, { rideEffectsPending: [], rideEffectsRetryAt: null });
          if (cleared.affected !== 1) {
            await repository.update({ id: candidate.id, rideEffectsRetryAt: Equal(leaseUntil) }, { rideEffectsRetryAt: new Date() });
          }
        } catch {
          this.logger.warn(`Manual ride follow-up pending for booking ${candidate.id}`);
        }
      }
    } finally { this.repairing = false; }
  }
}
