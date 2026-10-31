import { assertSequentialInvitation } from '../trip-requests/dispatch/sequential-policy';
import { assertRequestTarget } from '../trip-requests/target-driver-policy';
import { assertRequestDriverProximity } from '../trip-requests/request-proximity';
import { hasRefusedRequest } from '../trip-requests/request-refusal';
import { assertDriverRequestSchedule } from '../trip-requests/dispatch/driver-schedule-policy';
import { ConflictException } from '@nestjs/common';
import { In, Repository } from 'typeorm';
import { Trip, TripStatus } from './entities/trip.entity';
import { TripRequest, TripRequestStatus } from '../trip-requests/entities/trip-request.entity';
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
  acceptanceToken?: string,
): Promise<Trip> {
  return repository.manager.transaction(async (manager) => {
    const request = await manager.getRepository(TripRequest).findOne({
      where: { id: snapshot.id },
      lock: { mode: 'pessimistic_write' },
    });
    assertRequestSnapshot(request, snapshot);
    // Starting a previously accepted counteroffer must be fenced against a
    // passenger changing driver while route preparation was still in flight.
    if (request!.status === TripRequestStatus.DRIVER_SELECTED) {
      if (request!.selectedDriverId !== trip.driverId || request!.tripId ||
          !(await manager.exists(DriverOffer, { where: {
            tripRequestId: snapshot.id, driverId: trip.driverId, status: DriverOfferStatus.ACCEPTED,
          } })) || await manager.exists(Trip, { where: {
            tripRequestId: snapshot.id, status: In([TripStatus.PENDING, TripStatus.ACTIVE, TripStatus.COMPLETED]),
          } })) throw new ConflictException('Cette prise en charge a changé. Actualisez la commande.');
      await assertDriverRequestSchedule(manager, trip.driverId, request!.id);
      return manager.save(Trip, trip);
    }
    assertUnassignedRequest(request!);
    assertRequestTarget(request!, trip.driverId);
    if (await hasRefusedRequest(manager, trip.driverId, request!.id))
      throw new ConflictException('Cette demande n’est plus disponible pour vous.');
    await assertSequentialInvitation(manager, request!, trip.driverId, acceptanceToken ? ['accepting'] : ['driver'], acceptanceToken);
    await assertRequestDriverProximity(manager, request!.id, trip.driverId);
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
    await assertDriverRequestSchedule(manager, trip.driverId, request!.id);
    return trips.save(trip);
  });
}
