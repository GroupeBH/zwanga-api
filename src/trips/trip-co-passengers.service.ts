import { ForbiddenException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BookingStatus } from '../bookings/entities/booking.entity';
import { Trip, TripStatus } from './entities/trip.entity';

type ParticipantRow = {
  tripId: string;
  id: string | null;
  userId: string | null;
  firstName: string | null;
  avatarUrl: string | null;
  seats: number | null;
};

@Injectable()
export class TripCoPassengersService {
  constructor(
    @InjectRepository(Trip) private readonly trips: Repository<Trip>,
  ) {}

  async list(tripId: string, viewerId: string) {
    if (!viewerId)
      throw new ForbiddenException('Réservation confirmée requise.');
    // A single uncached statement checks membership and reads the limited roster.
    // Never reuse the shared trip cache or the driver-only booking representation.
    const rows = await this.trips
      .createQueryBuilder('trip')
      .leftJoin(
        'trip.bookings',
        'membership',
        'membership.passengerId = :viewerId AND membership.status IN (:...confirmed)',
      )
      .leftJoin(
        'trip.bookings',
        'fellow',
        'fellow.passengerId != :viewerId AND fellow.status IN (:...confirmed)',
      )
      .leftJoin('fellow.passenger', 'profile', 'profile.isActive = true')
      .select('trip.id', 'tripId')
      .addSelect('fellow.id', 'id')
      .addSelect('profile.id', 'userId')
      .addSelect('profile.firstName', 'firstName')
      .addSelect('profile.profilePicture', 'avatarUrl')
      .addSelect('fellow.numberOfSeats', 'seats')
      .where('trip.id = :tripId', { tripId })
      .andWhere('trip.isPrivate = false AND trip.tripRequestId IS NULL')
      .andWhere('trip.status IN (:...tripStatuses)', {
        tripStatuses: [
          TripStatus.PENDING,
          TripStatus.ACTIVE,
          TripStatus.COMPLETED,
        ],
      })
      .andWhere('(membership.id IS NOT NULL OR trip.driverId = :viewerId)')
      .setParameters({
        viewerId,
        confirmed: [BookingStatus.ACCEPTED, BookingStatus.COMPLETED],
      })
      .orderBy('fellow.createdAt', 'ASC')
      .addOrderBy('fellow.id', 'ASC')
      .getRawMany<ParticipantRow>();
    // Do not distinguish an absent/private trip from one the requester cannot access.
    if (!rows.length)
      throw new ForbiddenException('Réservation confirmée requise.');
    const seen = new Set<string>();
    const participants = rows.flatMap((row) => {
      if (!row.id || seen.has(row.id)) return [];
      seen.add(row.id);
      return [
        {
          id: row.id,
          userId: row.userId ?? null,
          firstName: row.firstName?.trim() || 'Passager',
          avatarUrl: row.avatarUrl || null,
          seats:
            Number.isInteger(Number(row.seats)) && Number(row.seats) > 0
              ? Number(row.seats)
              : 1,
        },
      ];
    });
    return { tripId, participants };
  }
}
