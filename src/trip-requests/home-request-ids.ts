import type { Repository } from 'typeorm';
import { TripRequest, TripRequestStatus } from './entities/trip-request.entity';
import { DriverOfferStatus } from './entities/driver-offer.entity';
import { latestDriverPositionSql, nearbyRequestDriverVisibilitySql } from './request-proximity';
import { UNACCEPTED_REQUEST_EXPIRATION_MS } from './request-edit-policy';

export const HOME_REQUEST_LIMIT = 10;

/** Rank the eligible set BEFORE limiting/hydrating relations. No history count or
 * pagination scan on Home. Browsing deliberately retains durable positions;
 * the 48-hour freshness limit applies only to ringing, not manual discovery. */
export async function homeRequestIds(repository: Repository<TripRequest>, driverId: string) {
  const rows = await repository.createQueryBuilder('request')
    .select('request.id', 'id')
    .where('request.status IN (:...states)', { states: [TripRequestStatus.PENDING, TripRequestStatus.OFFERS_RECEIVED] })
    .andWhere(nearbyRequestDriverVisibilitySql('request.id', ':driverId'), { driverId })
    .andWhere('request.passengerId <> :driverId', { driverId })
    .andWhere('request.selectedDriverId IS NULL AND request.tripId IS NULL')
    .andWhere('request.departureDateMax > :cutoff', { cutoff: new Date(Date.now() - UNACCEPTED_REQUEST_EXPIRATION_MS) })
    .andWhere('NOT EXISTS (SELECT 1 FROM driver_offers accepted WHERE accepted."tripRequestId" = request.id AND accepted.status = :accepted)',
      { accepted: DriverOfferStatus.ACCEPTED })
    .orderBy(`ST_Distance(request."departurePoint", ${latestDriverPositionSql(':driverId')})`, 'ASC')
    .addOrderBy('request.createdAt', 'DESC').addOrderBy('request.id', 'ASC')
    .limit(HOME_REQUEST_LIMIT).getRawMany<{ id: string }>();
  return rows.map(row => row.id);
}
