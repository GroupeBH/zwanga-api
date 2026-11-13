import { ConflictException, NotFoundException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { DriverOffer, DriverOfferStatus } from './entities/driver-offer.entity';
import { TripRequest, TripRequestStatus } from './entities/trip-request.entity';
import { lockAvailableAccounts } from '../users/account-availability';
import { assertUnassignedRequest } from './request-edit-policy';
import { assertRequestTarget } from './target-driver-policy';
import { assertMinimumTripPrice } from './trip-request-pricing';
import {
  startPassengerDecision,
  PASSENGER_DECISION_MS,
} from './dispatch/request-acceptance';
import { enqueueTransactionalNotification } from '../notifications/transactional-notification';
import { RETIRE_COUNTEROFFER_NOTIFICATIONS_SQL } from './dispatch/retire-request-invitations';

/** A revision gets a new ID: stale buttons, push retries and cached prices cannot accept it. */
export async function negotiateRequestPrice(
  database: EntityManager,
  actorId: string,
  requestId: string,
  offerId: string,
  pricePerSeat: number,
  stage: 'passenger_counter' | 'driver_final',
) {
  if (!Number.isSafeInteger(pricePerSeat) || pricePerSeat > 1000000)
    throw new ConflictException('Prix invalide.');
  assertMinimumTripPrice(pricePerSeat);
  const snapshot = await database.findOneBy(TripRequest, { id: requestId });
  const previous = await database.findOneBy(DriverOffer, {
    id: offerId,
    tripRequestId: requestId,
  });
  if (
    !snapshot ||
    !previous ||
    previous.existingTripId ||
    actorId !==
      (stage === 'passenger_counter' ? snapshot.passengerId : previous.driverId)
  )
    throw new NotFoundException('Proposition introuvable.');
  return database.transaction(async (manager) => {
    await lockAvailableAccounts(manager, [
      snapshot.passengerId,
      previous.driverId,
    ]);
    const request = await manager.findOne(TripRequest, {
      where: { id: requestId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!request || request.passengerId !== snapshot.passengerId)
      throw new NotFoundException('Commande introuvable.');
    assertUnassignedRequest(request);
    assertRequestTarget(request, previous.driverId);
    if (request.departureDateMax.getTime() <= Date.now())
      throw new ConflictException('Le délai de réponse est terminé.');
    const offers = manager.getRepository(DriverOffer);
    const offer = await offers.findOneBy({
      id: offerId,
      tripRequestId: requestId,
    });
    const expected =
      stage === 'passenger_counter' ? 'driver_initial' : 'passenger_counter';
    if (
      !offer ||
      offer.status !== DriverOfferStatus.PENDING ||
      offer.negotiationStage !== expected
    )
      throw new ConflictException('Ce prix a changé. Actualisez la commande.');
    if (pricePerSeat === Number(offer.pricePerSeat))
      throw new ConflictException(
        'Ce prix est identique. Utilisez le bouton Accepter.',
      );
    // The existing exclusive response lease remains active throughout negotiation.
    // Each of the two bounded turns gets the existing 120s window, never past departure.
    await startPassengerDecision(manager, request, offer.driverId, [
      'passenger',
    ]);
    await offers.update(offer.id, { status: DriverOfferStatus.CANCELLED });
    const next = offers.create({
      ...offer,
      id: randomUUID(),
      driver: undefined,
      vehicle: undefined,
      tripRequest: undefined,
      existingTrip: undefined,
      sharedBooking: undefined,
      previousOfferId: offer.id,
      negotiationStage: stage,
      pricePerSeat,
      status: DriverOfferStatus.PENDING,
      createdAt: new Date(),
      updatedAt: new Date(),
      acceptedAt: null,
      rejectedAt: null,
      rejectionReason: null,
    });
    await offers.save(next);
    await manager.update(TripRequest, requestId, {
      status: TripRequestStatus.OFFERS_RECEIVED,
      updatedAt: new Date(),
    });
    await manager.query(RETIRE_COUNTEROFFER_NOTIFICATIONS_SQL, [
      requestId,
      [offer.id],
    ]);
    const toDriver = stage === 'passenger_counter';
    await enqueueTransactionalNotification(manager, {
      eventKey: `counter-offer:${next.id}`,
      userId: toDriver ? offer.driverId : request.passengerId,
      title: toDriver
        ? 'Le passager propose un prix'
        : 'Le conducteur propose son prix ferme',
      body: `${pricePerSeat * request.numberOfSeats} FC pour le trajet. Ouvrez la commande pour répondre.`,
      data: {
        type: 'driver_offer',
        ringAlert: 'counter-offer-v1',
        role: toDriver ? 'driver' : 'passenger',
        negotiationStage: stage,
        tripRequestId: requestId,
        offerId: next.id,
        driverId: offer.driverId,
        passengerId: request.passengerId,
        pricePerSeat,
        numberOfSeats: request.numberOfSeats,
        ringUntil: new Date(
          Math.min(Date.now() + 60000, request.departureDateMax.getTime()),
        ).toISOString(),
        alertExpiresAt: new Date(
          Math.min(
            Date.now() + PASSENGER_DECISION_MS,
            request.departureDateMax.getTime(),
          ),
        ).toISOString(),
      },
    });
    return next;
  });
}
