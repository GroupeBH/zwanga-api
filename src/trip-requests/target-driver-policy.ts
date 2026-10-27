import { NotFoundException } from '@nestjs/common';
import { requestNotRefusedSql } from './request-refusal';

/** Internal expressions only; all user identifiers are bound SQL parameters. */
export const requestDriverVisibilitySql = (requestId: string, driverId: string) =>
  `${requestNotRefusedSql(requestId, driverId)} AND EXISTS
    (SELECT 1 FROM trip_requests targeted WHERE targeted.id = ${requestId} AND (targeted."targetDriverId" IS NULL OR targeted."targetDriverId" = ${driverId}))`;

export function assertRequestTarget(request: { targetDriverId?: string | null }, driverId: string) {
  if (request.targetDriverId && request.targetDriverId !== driverId)
    throw new NotFoundException('Commande introuvable.');
}
