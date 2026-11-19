import { latestDriverPositionSql, nearbyRequestDriverVisibilitySql } from './request-proximity';
import { Repository } from 'typeorm';
import { HistoryPageQuery, historyContext, loadHistoryIds } from '../common/history-page';
import { TripRequest, TripRequestStatus } from './entities/trip-request.entity';
import { DriverOffer, DriverOfferStatus } from './entities/driver-offer.entity';
import { UNACCEPTED_REQUEST_EXPIRATION_MS } from './request-edit-policy';
import { RequestDiscoveryQuery } from './dto/request-discovery.dto';

/** Select bounded IDs before loading to-many offers. Authorization stays in the service. */
function requestPageQuery(repository: Repository<TripRequest>, userId: string,
  own: boolean, options: HistoryPageQuery, routeOnly = false) {
  const context = historyContext(options, own ? 'requests-own' : 'requests-available');
  const query = repository.createQueryBuilder('request')
    .where('request.createdAt <= :asOf', { asOf: new Date(context.asOf) });
  if (own) query.andWhere('request.passengerId = :userId', { userId });
  else query.andWhere('request.status IN (:...states)', { states: [TripRequestStatus.PENDING, TripRequestStatus.OFFERS_RECEIVED] })
    .andWhere(nearbyRequestDriverVisibilitySql('request.id', ':userId'), { userId })
    .andWhere('request.passengerId <> :userId', { userId })
    .andWhere('request.selectedDriverId IS NULL AND request.tripId IS NULL')
    .andWhere('request.departureDateMax > :cutoff', { cutoff: new Date(Date.now() - UNACCEPTED_REQUEST_EXPIRATION_MS) })
    .andWhere('NOT EXISTS (SELECT 1 FROM driver_offers accepted WHERE accepted."tripRequestId" = request.id AND accepted.status = :accepted)',
      { accepted: DriverOfferStatus.ACCEPTED });
  if (context.search) {
    if (!routeOnly) {
      query.leftJoin('request.passenger', 'passenger');
      query.leftJoin('request.selectedDriver', 'selectedDriver');
    }
    // Match the app's word-order-independent search, including address references.
    // Column names are fixed here; every search term remains a bound literal.
    const text = `translate(lower(concat_ws(' ', request.departureLocation, request.arrivalLocation,
      request.departureReference, request.arrivalReference${routeOnly ? '' : ', passenger.firstName, passenger.lastName, selectedDriver.firstName, selectedDriver.lastName'})),
      'àâäáãåçéèêëìíîïñòóôöõùúûüýÿÀÂÄÁÃÅÇÉÈÊËÌÍÎÏÑÒÓÔÖÕÙÚÛÜÝŸ', 'aaaaaaceeeeiiiinooooouuuuyyaaaaaaceeeeiiiinooooouuuuyy')`;
    [...new Set(context.search.split(/\s+/).filter(Boolean))].forEach((term, index) => {
      const parameter = `requestTerm${index}`;
      query.andWhere(`${text} LIKE :${parameter} ESCAPE '!'`, {
        [parameter]: `%${term.replace(/[!%_]/g, '!$&')}%`,
      });
    });
  }
  return { query, context };
}

export async function requestPageIds(repository: Repository<TripRequest>, userId: string,
  own: boolean, options: HistoryPageQuery) {
  const { query, context } = requestPageQuery(repository, userId, own, options);
  const total = await query.clone().getCount();
  return { ...await loadHistoryIds(query, options, context, 'request.id', 'request.createdAt'), total };
}

/** Global filters/order before hydration. Live availability is rechecked in the service. */
export async function requestDiscoveryIds(repository: Repository<TripRequest>, userId: string, options: RequestDiscoveryQuery) {
  const { query } = requestPageQuery(repository, userId, false, { search: options.search }, true);
  query.andWhere('request.numberOfSeats >= :minSeats', { minSeats: options.minSeats ?? 1 });
  const total = await query.clone().getCount();
  const page = options.page ?? 1, limit = Math.min(100, options.limit ?? 30);
  query.select('request.id', 'id');
  if (options.sort === 'cheap') query.orderBy('request.maxPricePerSeat', 'DESC', 'NULLS LAST');
  else if (options.sort === 'nearby' || !options.sort) query.orderBy(`ST_Distance(request."departurePoint", ${latestDriverPositionSql(':userId')})`, 'ASC', 'NULLS LAST');
  query.addOrderBy('request.departureDateMin', 'ASC').addOrderBy('request.id', 'ASC');
  const rows = await query.offset((page - 1) * limit).limit(limit).getRawMany<{ id: string }>();
  return { ids: rows.map(row => row.id), total, page, limit, hasMore: page * limit < total, nextCursor: null };
}

export async function offerPageIds(repository: Repository<DriverOffer>, driverId: string, options: HistoryPageQuery) {
  const context = historyContext(options, 'driver-offers');
  const query = repository.createQueryBuilder('offer').where('offer.driverId = :driverId', { driverId })
    .andWhere('offer.createdAt <= :asOf', { asOf: new Date(context.asOf) });
  const total = await query.clone().getCount();
  return { ...await loadHistoryIds(query, options, context, 'offer.id', 'offer.createdAt'), total };
}
