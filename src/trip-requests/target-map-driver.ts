import { ConflictException, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { EntityManager, In, QueryFailedError } from 'typeorm';
import { Trip, TripStatus } from '../trips/entities/trip.entity';
import { TripRequest } from './entities/trip-request.entity';
import { TargetMapDriverDto } from './dto/target-map-driver.dto';
import { requestMapCandidates, requestMapMarkerId } from './request-search-map';
import { assertUnassignedRequest } from './request-edit-policy';
import { retireRequestInvitations } from './dispatch/retire-request-invitations';
import { enqueueTransactionalNotification } from '../notifications/transactional-notification';
import { Notification } from '../notifications/entities/notification.entity';
import { rideSpeechData } from '../notifications/ride-speech-data';

export const MAP_DRIVER_RESPONSE_MS = 180_000;

/** Request -> driver lock order, no push/Redis call inside the transaction. */
export async function targetMapDriver(
  database: EntityManager,
  passengerId: string,
  requestId: string,
  dto: TargetMapDriverDto,
) {
  return database
    .transaction(async (manager) => {
      await manager.query("SET LOCAL lock_timeout='3s'");
      const repository = manager.getRepository(TripRequest);
      const request = await repository.findOne({
        where: { id: requestId, passengerId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!request) throw new NotFoundException('Commande introuvable.');
      const eventKey = `map-driver:${requestId}:${dto.markerId}:${new Date(dto.expectedUpdatedAt).toISOString()}`;
      // A retry after a lost HTTP response must not restart the three-minute timer.
      if (
        await manager
          .getRepository(Notification)
          .exists({ where: { eventKey } })
      )
        return;
      assertUnassignedRequest(request);
      if (request.updatedAt.getTime() !== Date.parse(dto.expectedUpdatedAt))
        throw new ConflictException(
          'Votre demande a changé. Actualisez avant de choisir un conducteur.',
        );
      if (
        request.targetDriverPriorityUntil ||
        request.departureDateMax.getTime() <= Date.now()
      )
        throw new ConflictException(
          'Terminez la recherche en cours avant de choisir un autre conducteur.',
        );
      if (
        (
          await manager.query<unknown[]>(
            `SELECT 1 FROM trip_request_dispatch_offers WHERE "requestId"=$1
      AND status='pending' AND phase<>'driver' LIMIT 1`,
            [requestId],
          )
        ).length ||
        (await manager.exists(Trip, {
          where: {
            tripRequestId: requestId,
            status: In([
              TripStatus.PENDING,
              TripStatus.ACTIVE,
              TripStatus.COMPLETED,
            ]),
          },
        }))
      )
        throw new ConflictException(
          'Un conducteur est déjà en train de répondre. Actualisez la demande.',
        );
      const find = async () =>
        (await requestMapCandidates(manager, passengerId, requestId))
          .slice(0, 500)
          .find(
            (row) =>
              requestMapMarkerId(requestId, row.markerSeed) === dto.markerId,
          );
      const first = await find();
      if (!first)
        throw new ConflictException(
          'Ce conducteur n’est plus disponible. Choisissez-en un autre.',
        );
      await manager.query(
        'SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE',
        [first.driverId],
      );
      const chosen = await find(); // Location, opt-out, vehicle, seats and schedule after the lock.
      if (!chosen)
        throw new ConflictException(
          'Ce conducteur n’est plus disponible. Choisissez-en un autre.',
        );
      await retireRequestInvitations(manager, requestId, true);
      const [{ until }] = await manager.query<{ until: Date }[]>(
        `SELECT LEAST(clock_timestamp()+$2*interval '1 millisecond', $1::timestamptz) AS until`,
        [request.departureDateMax, MAP_DRIVER_RESPONSE_MS],
      );
      await repository.update(requestId, {
        id: requestId,
        status: request.status,
        targetDriverId: chosen.driverId,
        targetDriverPriorityUntil: until,
        sequentialDispatch: true,
        dispatchCheckedAt: null,
      });
      const offerId = randomUUID();
      // A new ID invalidates old notification actions, including an expired invitation
      // to this same driver. There is no FK pointing at dispatch invitation IDs.
      await manager.query(
        `INSERT INTO trip_request_dispatch_offers
      (id,"requestId","driverId","vehicleId",seats,status,phase,"expiresAt",sequential)
      VALUES ($1,$2,$3,$4,$5,'pending','driver',$6,true)
      ON CONFLICT ("requestId","driverId") DO UPDATE SET id=EXCLUDED.id,"vehicleId"=EXCLUDED."vehicleId",
        seats=EXCLUDED.seats,status='pending',phase='driver',"acceptanceToken"=NULL,
        "expiresAt"=EXCLUDED."expiresAt","createdAt"=clock_timestamp(),sequential=true`,
        [
          offerId,
          requestId,
          chosen.driverId,
          chosen.markerSeed,
          chosen.seats,
          until,
        ],
      );
      // Keep the rolling-deployment 40 s INSERT guard for ordinary invitations.
      // Only this owner-selected invitation receives the explicit three-minute lease.
      await manager.query(
        'UPDATE trip_request_dispatch_offers SET "expiresAt"=$2 WHERE id=$1',
        [offerId, until],
      );
      const expiresAt = new Date(until).toISOString();
      await enqueueTransactionalNotification(manager, {
        eventKey,
        userId: chosen.driverId,
        title: 'Un passager vous a choisi',
        body: `${request.departureLocation} → ${request.arrivalLocation}. Accepter ou refuser ?`,
        data: {
          type: 'trip_request_nearby',
          ringAlert: 'nearby-request-v1',
          mapDriverPriority: true,
          tripRequestId: requestId,
          offerId,
          driverId: chosen.driverId,
          passengerId,
          role: 'driver',
          vehicleType: request.vehicleType,
          expiresAt,
          alertExpiresAt: expiresAt,
          ...rideSpeechData({
            departure: request.departureLocation,
            arrival: request.arrivalLocation,
            seats: request.numberOfSeats,
            departureAt: request.departureDateMin,
            pricePerSeat: request.maxPricePerSeat,
            priceKind: 'budget',
          }),
        },
      });
    })
    .catch((error: unknown) => {
      const code =
        error instanceof QueryFailedError
          ? (error.driverError as { code?: string }).code
          : undefined;
      if (code && ['23505', '55P03', '40P01'].includes(code))
        throw new ConflictException(
          'Une réponse est en cours ou ce conducteur vient d’être sollicité. Actualisez la demande.',
        );
      throw error;
    });
}

/** Caller holds the request row lock and has retired expired invitation/response leases. */
export async function resumeExpiredMapPriority(
  manager: EntityManager,
  request: TripRequest,
): Promise<boolean> {
  if (
    !request.targetDriverPriorityUntil ||
    request.selectedDriverId ||
    request.tripId
  )
    return false;
  const [rows, count] = await manager.query<[{ id: string }[], number]>(
    `UPDATE trip_requests r SET "targetDriverId"=NULL,
    "targetDriverPriorityUntil"=NULL,"updatedAt"=clock_timestamp() WHERE r.id=$1
    AND r."targetDriverPriorityUntil"<=clock_timestamp() AND NOT EXISTS
      (SELECT 1 FROM trip_request_dispatch_offers o WHERE o."requestId"=r.id AND o.status='pending') RETURNING r.id`,
    [request.id],
  );
  if (!count || !rows.length) return false;
  request.targetDriverId = null;
  request.targetDriverPriorityUntil = null;
  return true;
}
