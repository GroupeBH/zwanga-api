import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

@Injectable()
export class TrackingStateService {
  constructor(private readonly db: DataSource) {}

  /** Recover committed state without joining a tracking room or returning other users' positions. */
  async read(userId: string, tripId: string, bookingId?: string) {
    const [state] = await this.db.query(`SELECT t.id AS "tripId", t.status AS "tripStatus",
      b.id AS "bookingId", b.status AS "bookingStatus", b."pickedUp", b."droppedOff"
      FROM trips t LEFT JOIN bookings b ON b."tripId"=t.id AND b.id=$3::uuid AND b."passengerId"=$1
      WHERE t.id=$2 AND (($3::uuid IS NULL AND t."driverId"=$1) OR b.id IS NOT NULL)
      LIMIT 1`, [userId, tripId, bookingId ?? null]);
    if (!state) throw new NotFoundException('Suivi introuvable.');
    return state;
  }
}
