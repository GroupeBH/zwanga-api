import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { RedisService } from '../common/services/redis.service';
import {
  LocationHistoryService,
  type LocationHistorySnapshot,
} from '../common/services/location-history.service';
import { enqueueTransactionalNotifications } from '../notifications/transactional-notification';
import { hasRideDispute } from '../ride-declarations/ride-declaration.model';
import { Booking } from './entities/booking.entity';
import { Trip } from '../trips/entities/trip.entity';
import {
  ARRIVAL_PROMPT_TTL_MS,
  ARRIVAL_STOP_MS,
  arrivalDestination,
  arrivalDistance,
  arrivalObservationMatchesTrip,
  observeArrivalStop,
  type ArrivalPrompt,
  type ArrivalStop,
} from './arrival-assistance.policy';

@Injectable()
export class ArrivalAssistanceService {
  constructor(
    private readonly db: DataSource,
    private readonly redis: RedisService,
    private readonly locations: LocationHistoryService,
  ) {}

  async latestObservation(tripId: string) {
    return (await this.locations.getDriverLocationHistory(tripId))?.current;
  }

  /** Bounded Redis state near the destination; no SQL writes on ordinary GPS samples. */
  async observe(
    booking: Booking,
    history: LocationHistorySnapshot | null,
  ): Promise<void> {
    const trip = booking.trip,
      point = history?.current,
      now = Date.now();
    if (
      !trip ||
      !point ||
      booking.arrivalPrompt ||
      booking.status !== 'accepted' ||
      trip.status !== 'ongoing' ||
      !booking.pickedUp ||
      booking.droppedOff ||
      !arrivalObservationMatchesTrip(point, trip, now) ||
      arrivalDistance(trip.currentLocation, arrivalDestination(booking, trip)) >
        200
    )
      return;
    const key = `arrival-assistance:stop:${booking.id}`;
    const previous = await this.redis.get<{
      stop: ArrivalStop | null;
      lastAt: number;
    }>(key);
    if (previous && Date.parse(point.recordedAt) <= previous.lastAt) return;
    let next = previous?.stop ?? null;
    const samples = [...(history?.samples ?? [point])].sort(
      (a, b) => Date.parse(a.recordedAt) - Date.parse(b.recordedAt),
    );
    const notBefore = new Date(
      booking.pickedUpAt ??
        booking.pickedUpConfirmedAt ??
        trip.startedAt ??
        NaN,
    ).getTime();
    for (const sample of samples) {
      if (previous && Date.parse(sample.recordedAt) <= previous.lastAt)
        continue;
      next = observeArrivalStop(
        next,
        sample,
        arrivalDestination(booking, trip),
        now,
        notBefore,
      );
    }
    // One CAS, no retry loop. A concurrent evaluation will continue on its next fix.
    if (
      !(await this.redis.compareAndSet(
        key,
        previous,
        { stop: next, lastAt: Date.parse(point.recordedAt) },
        600,
      ))
    )
      return;
    if (
      !next ||
      next.lastAt - next.since <= ARRIVAL_STOP_MS ||
      next.observations < 8
    )
      return;
    await this.propose(booking.id, trip.id, point);
  }

  private async propose(
    bookingId: string,
    tripId: string,
    observation: NonNullable<LocationHistorySnapshot['current']>,
  ) {
    await this.db.transaction(async (manager) => {
      const trip = await manager.findOne(Trip, {
        where: { id: tripId },
        lock: { mode: 'pessimistic_write' },
      });
      const booking = await manager
        .getRepository(Booking)
        .createQueryBuilder('b')
        .addSelect('b.rideDeclarations')
        .where('b.id = :bookingId', { bookingId })
        .setLock('pessimistic_write')
        .getOne();
      const now = Date.now();
      if (
        !trip ||
        !booking ||
        booking.tripId !== trip.id ||
        booking.arrivalPrompt ||
        booking.status !== 'accepted' ||
        trip.status !== 'ongoing' ||
        !booking.pickedUp ||
        booking.droppedOff ||
        hasRideDispute(booking.rideDeclarations) ||
        !arrivalObservationMatchesTrip(observation, trip, now) ||
        arrivalDistance(
          trip.currentLocation,
          arrivalDestination(booking, trip),
        ) > 100
      )
        return;
      const prompt: ArrivalPrompt = {
        id: randomUUID(),
        proposedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + ARRIVAL_PROMPT_TTL_MS).toISOString(),
      };
      // update:false protects this receipt from unrelated entity saves.
      await manager.query(
        'UPDATE bookings SET "arrivalPrompt"=$2::jsonb WHERE id=$1',
        [booking.id, JSON.stringify(prompt)],
      );
      await enqueueTransactionalNotifications(
        manager,
        [booking.passengerId, trip.driverId].map((userId) => ({
          eventKey: `arrival-prompt:${prompt.id}:${userId}`,
          userId,
          title: 'Êtes-vous arrivé à destination ?',
          body:
            userId === booking.passengerId
              ? 'Le véhicule est arrêté près de votre destination. Confirmez uniquement si vous êtes descendu : cela termine votre course et ouvre le paiement.'
              : 'Le véhicule est arrêté près de la destination. Le passager peut confirmer sa dépose ; vérifiez que la course est terminée avant d’encaisser.',
          data: {
            type: 'arrival_confirmation_requested',
            bookingId: booking.id,
            tripId: trip.id,
            promptId: prompt.id,
            expiresAt: prompt.expiresAt,
            role: userId === trip.driverId ? 'driver' : 'passenger',
          },
        })),
      );
    });
  }
}
