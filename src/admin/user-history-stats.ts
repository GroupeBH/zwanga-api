import type { EntityManager } from 'typeorm';

/** Exact counters independent from the displayed page, without hydrating histories. */
export async function userHistoryStats(manager: EntityManager, userId: string) {
  const [row] = await manager.query(`SELECT
    (SELECT count(*)::int FROM trips WHERE "driverId"=$1) trips,
    (SELECT count(*)::int FROM bookings WHERE "passengerId"=$1) "bookingsAsPassenger",
    (SELECT count(*)::int FROM bookings b JOIN trips t ON t.id=b."tripId" WHERE t."driverId"=$1) "bookingsAsDriver",
    (SELECT count(*)::int FROM payment_transactions WHERE "userId"=$1) payments,
    (SELECT count(*)::int FROM trip_requests WHERE "passengerId"=$1) "tripRequests",
    (SELECT coalesce(sum(amount),0) FROM payment_transactions WHERE "userId"=$1 AND status='succeeded') "succeededPaymentsAmount"`, [userId]);
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Number(value)]));
}
