import { randomUUID } from 'node:crypto';
import type { EntityManager } from 'typeorm';
import type { TripRequest } from '../entities/trip-request.entity';
import { lockQueuedCandidates, type QueueCandidate } from './sequential-candidates';
import { REQUEST_RESPONSE_MS } from './sequential-policy';

type Invitation = { candidate: QueueCandidate; offerId: string; expiresAt: Date; waveSlot: number };

/** Caller holds the request row lock and commits the outbox in this transaction.
 * The existing unique indexes arbitrate cross-request races; no Redis value is
 * accepted as proof of availability. Never lock or validate more than four at once. */
export async function reserveRequestWave(manager: EntityManager, request: TripRequest,
  driverIds: string[], waveSize: 1 | 4): Promise<Invitation[]> {
  const size = request.targetDriverId ? 1 : waveSize;
  let remaining = [...new Set(driverIds)], checkedCount = 0;
  const invitations: Invitation[] = [];
  while (remaining.length && checkedCount < 8 * size && invitations.length < size) {
    const checked = await lockQueuedCandidates(manager, request, remaining,
      Math.min(size - invitations.length, 8 * size - checkedCount));
    if (!checked.length) break;
    checkedCount += checked.length;
    const checkedIds = new Set(checked.map(row => row.driverId));
    remaining = remaining.filter(id => !checkedIds.has(id));
    const slots = Array.from({ length: size }, (_, i) => i + 1)
      .filter(slot => !invitations.some(invitation => invitation.waveSlot === slot));
    const candidates = checked.flatMap(row => row.candidate ? [row.candidate] : []);
    if (!candidates.length) continue;
    const proposed = candidates.map((candidate, i) => ({ id: randomUUID(),
      driverId: candidate.driverId, vehicleId: candidate.vehicleId, seats: candidate.seats, waveSlot: slots[i] }));
    const written: { id: string; driverId: string; expiresAt: Date; waveSlot: number }[] = await manager.query(
      `INSERT INTO trip_request_dispatch_offers
      (id,"requestId","driverId","vehicleId",seats,"expiresAt",sequential,"waveSlot")
      SELECT v.id,$2::uuid,v."driverId",v."vehicleId",v.seats,
        LEAST(clock_timestamp() + $3 * interval '1 millisecond', $4::timestamptz),true,v."waveSlot"
      FROM jsonb_to_recordset($1::jsonb) AS v(id uuid,"driverId" uuid,"vehicleId" uuid,seats int,"waveSlot" smallint)
      ORDER BY v."waveSlot" ON CONFLICT DO NOTHING RETURNING id,"driverId","expiresAt","waveSlot"`,
      [JSON.stringify(proposed), request.id, REQUEST_RESPONSE_MS, request.departureDateMax]);
    // A competing insertion may win after the validation snapshot. Only committed
    // INSERT results earn an outbox entry; reuse any unfilled slot on the next pass.
    for (const row of written) invitations.push({ candidate: candidates.find(c => c.driverId === row.driverId)!,
      offerId: row.id, expiresAt: new Date(row.expiresAt), waveSlot: row.waveSlot });
  }
  if (invitations.length) {
    const presence = request.immediateDispatch
      ? invitations.filter(invitation => !invitation.candidate.existingTripId).map(invitation => invitation.candidate) : [];
    // Still follows INSERT in a fresh statement: a rolling-deployment trigger
    // may change expiresAt. Only combine the disjoint deadline/presence writes.
    await manager.query(`WITH deadlines AS (
      UPDATE trip_request_dispatch_offers SET "deliveryDeadlineAt"="expiresAt"
        WHERE id=ANY($1::uuid[]) RETURNING id
    ) UPDATE driver_dispatch_presence p SET "vehicleId"=v."vehicleId", seats=v.seats
      FROM jsonb_to_recordset($2::jsonb) AS v("driverId" uuid,"vehicleId" uuid,seats int)
      WHERE p."driverId"=v."driverId"`, [invitations.map(invitation => invitation.offerId), JSON.stringify(presence)]);
  }
  // The relay acknowledges the Redis queue through the last reserved driver.
  // A reused slot is not necessarily the last candidate in that queue.
  const order = new Map([...new Set(driverIds)].map((id, i) => [id, i]));
  return invitations.sort((a, b) => order.get(a.candidate.driverId)! - order.get(b.candidate.driverId)!);
}
