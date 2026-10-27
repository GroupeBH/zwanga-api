import { ConflictException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

export const REQUEST_RESPONSE_MS = 40_000;
/** Internal SQL expressions only. Candidate discovery deliberately does not use this gate. */
export const sequentialInvitationSql = (requestId: string, driverId: string) => {
  // Raw() may supply TypeORM's capitalized alias; quote it explicitly in the subquery.
  const reference = requestId.replace(/^([A-Za-z_]\w*)\.([A-Za-z_]\w*)$/, '"$1"."$2"');
  return `EXISTS (SELECT 1 FROM trip_requests sq WHERE sq.id = ${reference}
    AND (sq."sequentialDispatch" = false OR sq."selectedDriverId" = ${driverId}
      OR EXISTS (SELECT 1 FROM trip_request_dispatch_offers so
        WHERE so."requestId" = sq.id AND so."driverId" = ${driverId}
          AND so.status = 'pending' AND so."expiresAt" > now())))`;
};

/** Recheck inside the same request-row lock used to commit acceptance. */
export async function assertSequentialInvitation(manager: EntityManager,
  request: { id: string; sequentialDispatch?: boolean; selectedDriverId?: string | null }, driverId: string, phases: string[] = ['driver'], token?: string) {
  if (!request.sequentialDispatch || request.selectedDriverId === driverId) return;
  const rows = await manager.query(`SELECT 1 FROM trip_request_dispatch_offers
    WHERE "requestId" = $1 AND "driverId" = $2 AND status = 'pending' AND "expiresAt" > clock_timestamp()
      AND phase = ANY($3::varchar[]) AND ($4::uuid IS NULL OR "acceptanceToken"=$4)`, [request.id, driverId, phases, token ?? null]);
  if (!rows.length) throw new ConflictException({ code: 'REQUEST_INVITATION_EXPIRED',
    message: 'Cette demande a été proposée à un autre conducteur.' });
}
