import type { EntityManager } from 'typeorm';

/** New server-created alerts carry their author. Old queued alerts resolve it
 * once by primary key; a missing/deleted order must not become a driver ring. */
export async function resolveDriverRequestOwner(
  manager: EntityManager,
  data: Record<string, unknown> | null,
): Promise<string | undefined> {
  if (typeof data?.passengerId === 'string' && data.passengerId.length) return data.passengerId;
  const requestId = data?.tripRequestId ?? data?.requestId;
  let rows: { passengerId: string }[];
  if (typeof requestId === 'string' && requestId.length) {
    rows = await manager.query('SELECT r."passengerId" FROM trip_requests r WHERE r.id = $1', [requestId]);
  } else if (data?.type === 'driver_dispatch_offer' && typeof data.offerId === 'string') {
    rows = await manager.query(`SELECT r."passengerId" FROM trip_request_dispatch_offers o
      JOIN trip_requests r ON r.id = o."requestId" WHERE o.id = $1`, [data.offerId]);
  } else if (data?.type === 'new_booking' && typeof data.bookingId === 'string') {
    rows = await manager.query('SELECT b."passengerId" FROM bookings b WHERE b.id = $1', [data.bookingId]);
  } else return undefined;
  return rows[0]?.passengerId;
}
