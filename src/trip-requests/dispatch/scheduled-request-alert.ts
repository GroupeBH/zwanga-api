import { requestDriverVisibilitySql } from '../target-driver-policy';
import type { EntityManager } from 'typeorm';
import { TripRequest, TripRequestStatus } from '../entities/trip-request.entity';
import { enqueueTransactionalNotifications } from '../../notifications/transactional-notification';
import { ELIGIBLE_NEARBY_DRIVER_SQL, NEARBY_DRIVER_BATCH_SIZE } from './nearby-driver-policy';
import { USABLE_DRIVER_LOCATION_SQL } from './driver-location-policy';
import { rideSpeechData } from '../../notifications/ride-speech-data';

/** Notification only: never creates an exclusive offer or changes a driver's availability. */
export async function enqueueScheduledRequestAlert(manager: EntityManager, requestId: string,
  radiusMeters: number, _isBusy?: (driverId: string) => Promise<boolean>): Promise<boolean> {
  const request = await manager.getRepository(TripRequest).findOne({
    where: { id: requestId }, lock: { mode: 'pessimistic_write', onLocked: 'skip_locked' },
  });
  if (!request || request.immediateDispatch || ![TripRequestStatus.PENDING, TripRequestStatus.OFFERS_RECEIVED].includes(request.status) ||
      request.selectedDriverId || request.tripId || !request.departurePoint ||
      request.departureDateMax.getTime() <= Date.now()) return false;
  await manager.getRepository(TripRequest).update(request.id, { dispatchCheckedAt: new Date(), updatedAt: () => '"updatedAt"' });
  const candidates: { driverId: string }[] = await manager.query(`
    SELECT p."driverId" FROM driver_dispatch_presence p
    WHERE ${USABLE_DRIVER_LOCATION_SQL} AND p."driverId" <> $1::uuid
    AND ST_DWithin(p.position, ST_SetSRID(ST_MakePoint($2,$3),4326)::geography, $4)
    AND ${requestDriverVisibilitySql('$7', 'p."driverId"')}
    AND ${ELIGIBLE_NEARBY_DRIVER_SQL}
    AND EXISTS (SELECT 1 FROM vehicles v WHERE v."ownerId" = p."driverId" AND v."isActive" = true
      AND v.type = $5 AND (CASE WHEN v.id = p."vehicleId" THEN p.seats
        WHEN v.type = 'motorcycle_2_wheels' THEN 2 WHEN v.type = 'motorcycle_3_wheels' THEN 3 ELSE 4 END) >= $6)
    AND NOT EXISTS (SELECT 1 FROM trip_request_dispatch_offers o
      WHERE o."driverId" = p."driverId" AND o.status = 'pending' AND o."expiresAt" > now())
    AND NOT EXISTS (SELECT 1 FROM notifications n WHERE
      n."eventKey" = 'nearby-scheduled-request:' || $7::text || ':' || p."driverId"::text
      OR (n."eventKey" = 'nearby-scheduled-request:' || $7::text AND n."userId"::text = p."driverId"::text))
    ORDER BY ST_Distance(p.position, ST_SetSRID(ST_MakePoint($2,$3),4326)::geography), p."driverId"
    LIMIT ${NEARBY_DRIVER_BATCH_SIZE}`, [request.passengerId, request.departurePoint.coordinates[0], request.departurePoint.coordinates[1],
      radiusMeters, request.vehicleType, request.numberOfSeats, request.id]);
  if (!candidates.length) return false;
  // Sound capability selects the transport at delivery, never the recipients.
  // The shared SQL applies the same eligibility/busy policy before
  // LIMIT. Avoid re-reading every candidate; delivery still checks current state.
  const departure = request.departureDateMin.toLocaleString('fr-FR', { timeZone: 'Africa/Kinshasa',
      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const alertExpiresAt = new Date(Date.now() + 60_000).toISOString();
  await enqueueTransactionalNotifications(manager, candidates.map(candidate => ({
      eventKey: `nearby-scheduled-request:${request.id}:${candidate.driverId}`, userId: candidate.driverId,
      title: 'Commande programmée à proximité',
      body: `${departure} · ${request.departureLocation} → ${request.arrivalLocation} · ${request.numberOfSeats} place(s). Consultez la commande.`,
      data: { type: 'trip_request_nearby', ringAlert: 'nearby-request-v1', tripRequestId: request.id, passengerId: request.passengerId,
        ...rideSpeechData({ departure: request.departureLocation, arrival: request.arrivalLocation,
          seats: request.numberOfSeats, departureAt: request.departureDateMin,
          pricePerSeat: request.maxPricePerSeat, priceKind: 'budget' }),
        driverId: candidate.driverId, role: 'driver', vehicleType: request.vehicleType, alertExpiresAt },
    })));
  return candidates.length > 0;
}
