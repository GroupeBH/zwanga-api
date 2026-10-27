import { ConflictException, NotFoundException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

/** Arguments are internal SQL expressions; identities are always bound parameters. */
export const requestNotRefusedSql = (requestId: string, driverId: string) =>
  `NOT EXISTS (SELECT 1 FROM trip_request_driver_refusals refusal
    WHERE refusal."requestId" = ${requestId} AND refusal."driverId" = ${driverId})`;

export async function hasRefusedRequest(manager: EntityManager, driverId: string, requestId: string): Promise<boolean> {
  const rows = await manager.query('SELECT 1 FROM trip_request_driver_refusals WHERE "driverId" = $1 AND "requestId" = $2', [driverId, requestId]);
  return rows.length > 0;
}

/** Caller holds the request lock, as acceptance and dispatch already do. */
export async function recordRequestRefusal(manager: EntityManager, driverId: string, requestId: string): Promise<void> {
  await manager.query(`INSERT INTO trip_request_driver_refusals ("driverId", "requestId")
    VALUES ($1, $2) ON CONFLICT ("driverId", "requestId") DO NOTHING`, [driverId, requestId]);
  await manager.query(`UPDATE notifications SET "isActive" = false
    WHERE "userId" = $1 AND "isActive" = true
      AND data ->> 'type' IN ('trip_request', 'new_trip_request', 'trip_request_nearby', 'driver_dispatch_offer')
      AND (data ->> 'tripRequestId' = $2::text OR data ->> 'requestId' = $2::text
        OR data ->> 'offerId' IN (SELECT id::text FROM trip_request_dispatch_offers
          WHERE "driverId" = $1 AND "requestId" = $2::uuid))`, [driverId, requestId]);
}

/** Also supports a request opened from the list, with no preceding push delivery. */
export async function declineRequestForDriver(manager: EntityManager, driverId: string, requestId: string) {
  return manager.transaction(async tx => {
    const [request] = await tx.query(`SELECT id, "passengerId", status, "selectedDriverId", "tripId", "targetDriverId"
      FROM trip_requests WHERE id = $1 FOR UPDATE`, [requestId]);
    if (!request || request.passengerId === driverId || (request.targetDriverId && request.targetDriverId !== driverId)) throw new NotFoundException('Commande introuvable.');
    if (!(await hasRefusedRequest(tx, driverId, requestId))) {
      if (!['pending', 'offers_received'].includes(request.status) || request.selectedDriverId || request.tripId)
        throw new ConflictException('Cette commande a déjà été prise en charge.');
      await recordRequestRefusal(tx, driverId, requestId);
      await tx.query(`UPDATE trip_request_dispatch_offers SET status = 'declined'
        WHERE "driverId" = $1 AND "requestId" = $2 AND status = 'pending'`, [driverId, requestId]);
      await tx.query(`UPDATE driver_offers SET status='cancelled', "updatedAt"=clock_timestamp()
        WHERE "driverId"=$1 AND "tripRequestId"=$2 AND status='pending'`, [driverId, requestId]);
      // A deliberate refusal after the ring deadline remains a refusal.
      await tx.query(`UPDATE nearby_driver_ring_events SET "declinedAt" = COALESCE("declinedAt", now()),
        "processedAt" = COALESCE("processedAt", now()), outcome = 'declined'
        WHERE "driverId" = $1 AND "requestId" = $2`, [driverId, requestId]);
    }
    return { missedCount: 0, mutedUntil: null, serverNow: new Date() };
  });
}
