import type { Repository } from 'typeorm';
import type { Booking } from './entities/booking.entity';
import { applyHistorySearch, historyContext, loadHistoryIds, type HistoryPageQuery } from '../common/history-page';

export function selectBookingHistory(repository: Repository<Booking>, passengerId: string, options: HistoryPageQuery) {
  const context = historyContext(options, 'bookings');
  const query = repository.createQueryBuilder('booking')
    .leftJoin('booking.trip', 'trip')
    .where('booking.passengerId = :passengerId', { passengerId })
    .andWhere(`(booking.status IN (:...closed) OR (booking.status IN (:...open)
      AND trip.status <> :ongoing AND trip.departureDate < :asOf))`,
      { closed: ['completed', 'cancelled', 'rejected', 'expired', 'no_show', 'boarding_uncertain'],
        open: ['pending', 'accepted'], ongoing: 'ongoing', asOf: context.asOf });
  if (context.search) query.leftJoin('trip.driver', 'driver').leftJoin('trip.vehicle', 'vehicle');
  applyHistorySearch(query, context.search, ['trip.departureLocation', 'trip.arrivalLocation',
    'booking.passengerDestination', 'driver.firstName', 'driver.lastName', 'vehicle.brand', 'vehicle.model', 'trip.description']);
  return loadHistoryIds(query, options, context, 'booking.id', 'COALESCE(trip.departureDate, booking.createdAt)');
}
