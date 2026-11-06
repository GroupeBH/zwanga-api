import { ConflictException, NotFoundException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { TripRequest, TripRequestStatus } from './entities/trip-request.entity';
import { DriverOffer, DriverOfferStatus } from './entities/driver-offer.entity';
import { assertUnassignedRequest } from './request-edit-policy';
import { recordRequestRefusal } from './request-refusal';
import { RETIRE_COUNTEROFFER_NOTIFICATIONS_SQL } from './dispatch/retire-request-invitations';
import { enqueueTransactionalNotification } from '../notifications/transactional-notification';

/** Owner decision, serialized with acceptance/withdrawal. Never cancels an assigned trip. */
export function rejectDriverOffer(database: EntityManager, passengerId: string, requestId: string, offerId: string) {
  return database.transaction(async manager => {
    const request = await manager.findOne(TripRequest, { where: { id: requestId, passengerId }, lock: { mode: 'pessimistic_write' } });
    const offer = request && await manager.findOneBy(DriverOffer, { id: offerId, tripRequestId: requestId });
    if (!request || !offer || offer.existingTripId) throw new NotFoundException('Proposition introuvable.');
    if (offer.status === DriverOfferStatus.REJECTED) return;
    assertUnassignedRequest(request);
    if (offer.status !== DriverOfferStatus.PENDING) throw new ConflictException('Cette proposition a déjà été traitée.');
    await manager.update(DriverOffer, offer.id, { status: DriverOfferStatus.REJECTED, rejectedAt: new Date() });
    await recordRequestRefusal(manager, offer.driverId, requestId);
    await manager.query(`UPDATE trip_request_dispatch_offers SET status='declined'
      WHERE "requestId"=$1 AND "driverId"=$2 AND status='pending' AND phase='passenger'`, [requestId, offer.driverId]);
    await manager.query(RETIRE_COUNTEROFFER_NOTIFICATIONS_SQL, [requestId, [offer.id]]);
    if (request.targetDriverId === offer.driverId) await manager.update(TripRequest, requestId,
      { targetDriverId: null, targetDriverPriorityUntil: null });
    const pending = await manager.countBy(DriverOffer, { tripRequestId: requestId, status: DriverOfferStatus.PENDING });
    await manager.update(TripRequest, requestId, { status: pending ? TripRequestStatus.OFFERS_RECEIVED : TripRequestStatus.PENDING });
    await enqueueTransactionalNotification(manager, { eventKey: `offer-rejected:${offer.id}`, userId: offer.driverId,
      title: 'Prix refusé', body: 'Le passager n’a pas retenu votre proposition. Vous pouvez consulter les autres demandes.',
      data: { type: 'driver_offer_rejected', tripRequestId: requestId, offerId, driverId: offer.driverId } });
  });
}
