import type { Repository } from 'typeorm';
import { Trip, TripStatus } from './entities/trip.entity';

/** Compensate only an empty provisional trip. Never cancel a committed reservation. */
export async function cancelEmptyRequestTrip(repository: Repository<Trip>, tripId: string, driverId: string, requestId: string) {
  return repository.manager.transaction('READ COMMITTED', async manager => {
    await manager.query(`SET LOCAL lock_timeout = '5s'`);
    await manager.query(`SET LOCAL statement_timeout = '10s'`);
    // FOR UPDATE also waits for the FK locks of an in-flight booking insert.
    // Check bookings in a subsequent statement with a fresh READ COMMITTED snapshot.
    const rows = await manager.query(`SELECT id FROM trips WHERE id=$1 AND "driverId"=$2
      AND "tripRequestId"=$3 AND status=$4 AND "isPrivate"=true FOR UPDATE`,
      [tripId, driverId, requestId, TripStatus.PENDING]);
    if (!rows.length) return false;
    const [cancelled] = await manager.query(`UPDATE trips SET status=$2,"updatedAt"=now()
      WHERE id=$1 AND NOT EXISTS (SELECT 1 FROM bookings WHERE "tripId"=$1) RETURNING id`,
      [tripId, TripStatus.CANCELLED]);
    return cancelled.length === 1;
  });
}
