import type { Repository } from 'typeorm';
import type { Trip } from './entities/trip.entity';
import { applyHistorySearch, historyContext, loadHistoryIds, type HistoryPageQuery } from '../common/history-page';

export function selectTripHistory(repository: Repository<Trip>, driverId: string, options: HistoryPageQuery) {
  const context = historyContext(options, 'trips');
  const query = repository.createQueryBuilder('trip')
    .where('trip.driverId = :driverId', { driverId })
    .andWhere(`(trip.status IN (:...closed) OR (trip.status = :upcoming AND trip.departureDate < :asOf))`,
      { closed: ['completed', 'cancelled'], upcoming: 'upcoming', asOf: context.asOf });
  if (context.search) query.leftJoin('trip.driver', 'driver').leftJoin('trip.vehicle', 'vehicle');
  applyHistorySearch(query, context.search, ['trip.departureLocation', 'trip.arrivalLocation',
    'driver.firstName', 'driver.lastName', 'vehicle.brand', 'vehicle.model', 'trip.description']);
  return loadHistoryIds(query, options, context, 'trip.id', 'trip.departureDate');
}
