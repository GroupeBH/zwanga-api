import { EntityManager } from 'typeorm';
import {
  TripRequest,
  TripRequestStatus,
} from '../entities/trip-request.entity';
import { enqueueTransactionalNotifications } from '../../notifications/transactional-notification';
import {
  ELIGIBLE_DRIVER_ACCOUNT_SQL,
  NEARBY_DRIVER_BATCH_SIZE,
  NEARBY_DRIVER_RADIUS_METERS,
} from './nearby-driver-policy';
import { rideSpeechData } from '../../notifications/ride-speech-data';
import { isUUID } from 'class-validator';

/** Recheck queued alerts; a trip may finish or fill up before the push is sent. */
export async function sharedTripAlertIsDeliverable(manager: EntityManager, driverId: string | null,
  requestId: unknown, tripId: unknown): Promise<boolean> {
  if (!driverId || !isUUID(driverId) || typeof requestId !== 'string' || !isUUID(requestId) ||
      typeof tripId !== 'string' || !isUUID(tripId)) return false;
  const rows = await manager.query(`SELECT 1 FROM trips t
    JOIN trip_requests r ON r.id = $2
    JOIN vehicles v ON v.id = t."vehicleId"::uuid AND v."ownerId" = t."driverId" AND v."isActive" = true
    WHERE t.id = $3 AND t."driverId" = $1 AND t.status = 'ongoing' AND t."destinationReachedAt" IS NULL
      AND t."availableSeats" >= r."numberOfSeats" AND v.type = r."vehicleType"
      AND r.status IN ('pending','offers_received') AND r."tripId" IS NULL
      AND r."selectedDriverId" IS NULL AND r."passengerId" <> $1 AND r."departureDateMax" > now()`,
    [driverId, requestId, tripId]);
  return rows.length > 0;
}

/** Non-exclusive notification. Busy drivers never receive a direct assignment. */
export async function enqueueSharedTripAlert(
  manager: EntityManager,
  requestId: string,
): Promise<boolean> {
  const request = await manager.findOne(TripRequest, {
    where: { id: requestId },
    lock: { mode: 'pessimistic_write', onLocked: 'skip_locked' },
  });
  if (
    !request ||
    ![TripRequestStatus.PENDING, TripRequestStatus.OFFERS_RECEIVED].includes(
      request.status,
    ) ||
    request.tripId ||
    request.selectedDriverId ||
    !request.departurePoint ||
    request.departureDateMax.getTime() <= Date.now() ||
    request.departureDateMin.getTime() > Date.now() + 10 * 60_000
  )
    return false;
  const candidates: { driverId: string; tripId: string }[] =
    await manager.query(
      `
    SELECT t."driverId", t.id AS "tripId" FROM trips t
    JOIN vehicles v ON v.id = t."vehicleId"::uuid AND v."ownerId" = t."driverId" AND v."isActive" = true
    LEFT JOIN driver_dispatch_presence p ON p."driverId" = t."driverId"
    WHERE t.status = 'ongoing' AND t."destinationReachedAt" IS NULL
      AND t."availableSeats" >= $2 AND v.type = $3 AND t."driverId" <> $4
      AND t."totalSeats" <= CASE WHEN v.type = 'motorcycle_2_wheels' THEN 2
        WHEN v.type = 'motorcycle_3_wheels' THEN 3 ELSE 20 END
      AND (t."isFree" = true OR (t."pricePerSeat" <= $5 AND $6 = ANY(t."acceptedPaymentModes")))
      AND p."discoveryEnabled" IS DISTINCT FROM false
      AND ${ELIGIBLE_DRIVER_ACCOUNT_SQL.replaceAll('p."driverId"', 't."driverId"')}
      AND ST_DWithin(COALESCE(t."currentLocation", p.position),
        ST_SetSRID(ST_MakePoint($7,$8),4326)::geography,$9)
      AND NOT EXISTS (SELECT 1 FROM driver_offers o WHERE o."tripRequestId" = $1 AND o."driverId" = t."driverId")
      AND NOT EXISTS (SELECT 1 FROM notifications n
        WHERE n."eventKey" = 'shared-trip-nearby:' || $1::text || ':' || t."driverId"::text)
    ORDER BY ST_Distance(COALESCE(t."currentLocation", p.position),
      ST_SetSRID(ST_MakePoint($7,$8),4326)::geography), t."driverId"
    LIMIT ${NEARBY_DRIVER_BATCH_SIZE}`,
      [
        requestId,
        request.numberOfSeats,
        request.vehicleType,
        request.passengerId,
        request.maxPricePerSeat,
        request.paymentMode,
        ...request.departurePoint.coordinates,
        NEARBY_DRIVER_RADIUS_METERS,
      ],
    );
  if (!candidates.length) return false;
  await enqueueTransactionalNotifications(
    manager,
    candidates.map((candidate) => ({
      eventKey: `shared-trip-nearby:${requestId}:${candidate.driverId}`,
      userId: candidate.driverId,
      title: 'Un passager peut rejoindre votre trajet',
      body: `${request.departureLocation} → ${request.arrivalLocation}. Proposez le partage ; le passager devra l’accepter.`,
      data: {
        type: 'trip_request_nearby',
        ringAlert: 'nearby-request-v1',
        sharedTrip: true,
        existingTripId: candidate.tripId,
        tripRequestId: requestId,
        passengerId: request.passengerId,
        driverId: candidate.driverId,
        role: 'driver',
        alertExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        ...rideSpeechData({
          departure: request.departureLocation,
          arrival: request.arrivalLocation,
          seats: request.numberOfSeats,
          departureAt: request.departureDateMin,
          pricePerSeat: request.maxPricePerSeat,
          priceKind: 'budget',
        }),
      },
    })),
  );
  return true;
}
