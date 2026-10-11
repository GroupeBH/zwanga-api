import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { EntityManager } from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { assertDriverCanOperate } from '../../users/driver-activation';
import { TripRequest, TripRequestStatus } from '../entities/trip-request.entity';
import { enqueueTransactionalNotification } from '../../notifications/transactional-notification';

/** Notification only: never creates an exclusive offer or changes a driver's availability. */
export async function enqueueScheduledRequestAlert(manager: EntityManager, requestId: string,
  radiusMeters: number, isBusy: (driverId: string) => Promise<boolean>): Promise<boolean> {
  const request = await manager.getRepository(TripRequest).findOne({
    where: { id: requestId }, lock: { mode: 'pessimistic_read' },
  });
  if (!request || request.immediateDispatch || request.status !== TripRequestStatus.PENDING ||
      request.selectedDriverId || request.tripId || !request.departurePoint ||
      request.departureDateMax.getTime() <= Date.now()) return false;
  const candidates: { driverId: string }[] = await manager.query(`
    SELECT p."driverId" FROM driver_dispatch_presence p
    WHERE p."expiresAt" > now() + interval '30 seconds' AND p."driverId" <> $1::uuid
    AND ST_DWithin(p.position, ST_SetSRID(ST_MakePoint($2,$3),4326)::geography, $4)
    AND EXISTS (SELECT 1 FROM vehicles v WHERE v."ownerId" = p."driverId" AND v."isActive" = true
      AND v.type = $5 AND (CASE WHEN v.id = p."vehicleId" THEN p.seats
        WHEN v.type = 'motorcycle_2_wheels' THEN 2 WHEN v.type = 'motorcycle_3_wheels' THEN 3 ELSE 4 END) >= $6)
    AND NOT EXISTS (SELECT 1 FROM trip_request_dispatch_offers o
      WHERE o."driverId" = p."driverId" AND o.status = 'pending' AND o."expiresAt" > now())
    ORDER BY ST_Distance(p.position, ST_SetSRID(ST_MakePoint($2,$3),4326)::geography), p."driverId"
    LIMIT 20`, [request.passengerId, request.departurePoint.coordinates[0], request.departurePoint.coordinates[1],
      radiusMeters, request.vehicleType, request.numberOfSeats]);
  for (const candidate of candidates) {
    const driver = await manager.getRepository(User).findOneBy({ id: candidate.driverId });
    if (!driver?.fcmToken || await isBusy(driver.id)) continue;
    try { await assertDriverCanOperate(manager, driver); } catch (error) {
      if (error instanceof BadRequestException || (error as { status?: number }).status === 403) continue;
      throw error;
    }
    const [capable] = await manager.query(`SELECT 1 FROM driver_notification_clients
      WHERE "userId" = $1 AND "tokenHash" = $2`,
      [driver.id, createHash('sha256').update(driver.fcmToken + ':driver-v2').digest('hex')]);
    if (!capable) continue;
    const departure = request.departureDateMin.toLocaleString('fr-FR', { timeZone: 'Africa/Kinshasa',
      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    await enqueueTransactionalNotification(manager, {
      eventKey: `nearby-scheduled-request:${request.id}`, userId: driver.id,
      title: 'Commande programmée à proximité',
      body: `${departure} · ${request.departureLocation} → ${request.arrivalLocation} · ${request.numberOfSeats} place(s). Consultez la commande.`,
      data: { type: 'trip_request_nearby', ringAlert: 'nearby-request-v1', tripRequestId: request.id,
        driverId: driver.id, role: 'driver', vehicleType: request.vehicleType,
        alertExpiresAt: new Date(Date.now() + 60_000).toISOString() },
    });
    return true;
  }
  return false;
}
