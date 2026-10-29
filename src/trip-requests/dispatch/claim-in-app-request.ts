import { ConflictException, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { EntityManager } from 'typeorm';
import type { TripRequest } from '../entities/trip-request.entity';
import { assertRequestTarget } from '../target-driver-policy';
import { hasRefusedRequest } from '../request-refusal';
import { assertDriverRequestSchedule } from './driver-schedule-policy';

/** Caller owns the request lock. Attention is not an exclusive right to respond. */
export async function claimInAppRequest(
  tx: EntityManager,
  request: TripRequest,
  driverId: string,
  token: string,
  durationMs: number,
  vehicle?: { vehicleId: string; seats: number },
) {
  assertRequestTarget(request, driverId);
  if (
    request.passengerId === driverId ||
    (await hasRefusedRequest(tx, driverId, request.id))
  )
    throw new NotFoundException('Commande introuvable.');
  // Even an expired preparation needs recovery before another worker can take over.
  const active = await tx.query<{ phase: string }[]>(
    `SELECT phase FROM trip_request_dispatch_offers
    WHERE "requestId"=$1 AND status='pending' AND phase<>'driver'`,
    [request.id],
  );
  if (active.length)
    throw new ConflictException(
      'Une réponse est en cours. Actualisez la demande.',
    );
  const [previous] = await tx.query<{ vehicleId: string; seats: number }[]>(
    `SELECT "vehicleId",seats FROM trip_request_dispatch_offers
    WHERE "requestId"=$1 AND "driverId"=$2`,
    [request.id, driverId],
  );
  const selected = vehicle ?? previous;
  if (!selected)
    throw new ConflictException(
      'Choisissez votre véhicule pour accepter la demande.',
    );
  await assertDriverRequestSchedule(tx, driverId, request.id);
  await tx.query(
    `UPDATE trip_request_dispatch_offers SET status='cancelled'
    WHERE "requestId"=$1 AND status='pending' AND phase='driver'`,
    [request.id],
  );
  await tx.query(
    `INSERT INTO trip_request_dispatch_offers
    (id,"requestId","driverId","vehicleId",seats,status,phase,"acceptanceToken","expiresAt",sequential)
    VALUES ($1,$2,$3,$4,$5,'pending','accepting',$6,clock_timestamp()+$7*interval '1 millisecond',true)
    ON CONFLICT ("requestId","driverId") DO UPDATE SET "vehicleId"=EXCLUDED."vehicleId",
      seats=EXCLUDED.seats,status='pending',phase='accepting',"acceptanceToken"=EXCLUDED."acceptanceToken",
      "expiresAt"=EXCLUDED."expiresAt",sequential=true`,
    [
      randomUUID(),
      request.id,
      driverId,
      selected.vehicleId,
      selected.seats,
      token,
      durationMs,
    ],
  );
  // The rolling-deployment INSERT trigger caps invitations at 40 s. Extend only
  // our fenced preparation, in this same transaction, as the existing UPDATE path did.
  await tx.query(
    `UPDATE trip_request_dispatch_offers SET "expiresAt"=clock_timestamp()+$4*interval '1 millisecond'
    WHERE "requestId"=$1 AND "driverId"=$2 AND "acceptanceToken"=$3 AND status='pending' AND phase='accepting'`,
    [request.id, driverId, token, durationMs],
  );
}
