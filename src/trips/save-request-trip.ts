import { ConflictException } from '@nestjs/common';
import { In, Repository } from 'typeorm';
import { Trip, TripStatus } from './entities/trip.entity';
import { TripRequest } from '../trip-requests/entities/trip-request.entity';
import {
  DriverOffer,
  DriverOfferStatus,
} from '../trip-requests/entities/driver-offer.entity';
import {
  assertRequestSnapshot,
  assertUnassignedRequest,
} from '../trip-requests/request-edit-policy';

/** Route resolution is already complete. Serialize only the final database write with editing. */
export function saveRequestTrip(
  repository: Repository<Trip>,
  trip: Trip,
  snapshot: TripRequest,
): Promise<Trip> {
  return repository.manager.transaction(async (manager) => {
    const request = await manager.getRepository(TripRequest).findOne({
      where: { id: snapshot.id },
      lock: { mode: 'pessimistic_write' },
    });
    assertRequestSnapshot(request, snapshot);
    assertUnassignedRequest(request!);
    const trips = manager.getRepository(Trip);
    if (
      (await trips.exists({
        where: {
          tripRequestId: snapshot.id,
          status: In([
            TripStatus.PENDING,
            TripStatus.ACTIVE,
            TripStatus.COMPLETED,
          ]),
        },
      })) ||
      (await manager
        .getRepository(DriverOffer)
        .exists({
          where: {
            tripRequestId: snapshot.id,
            status: DriverOfferStatus.ACCEPTED,
          },
        }))
    )
      throw new ConflictException(
        'Une prise en charge existe déjà pour cette demande.',
      );
    return trips.save(trip);
  });
}
