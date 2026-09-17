import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { HistoryPageQuery, applyHistorySearch, historyContext, loadHistoryIds, orderHistory } from './history-page';
import { selectTripHistory } from '../trips/trip-history';
import { selectBookingHistory } from '../bookings/booking-history';
import { TripStatus } from '../trips/entities/trip.entity';
import { BookingStatus } from '../bookings/entities/booking.entity';

const rows = [3, 2, 1].map(id => ({ id: `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`, at: '2026-09-17T12:00:00.123456' }));
const now = new Date('2026-09-17T13:00:00Z');
function fixture() {
  const query: any = {};
  for (const method of ['select', 'addSelect', 'orderBy', 'addOrderBy', 'limit', 'andWhere', 'where', 'leftJoin']) {
    query[method] = jest.fn(() => query);
  }
  query.getRawMany = jest.fn().mockResolvedValue(rows);
  return { query, repository: { createQueryBuilder: jest.fn(() => query) } as any };
}

describe('bounded ride histories', () => {
  it('uses microsecond timestamp/UUID boundaries with a stable expiry cutoff and no to-many join', async () => {
    const { query } = fixture();
    const page = await loadHistoryIds(query, { limit: 2 }, historyContext({}, 'trips', now), 'trip.id', 'trip.departureDate');
    expect(page.ids).toEqual(rows.slice(0, 2).map(row => row.id));
    expect(query.limit).toHaveBeenCalledWith(3);
    expect(query.orderBy).toHaveBeenCalledWith('trip.departureDate', 'DESC');
    expect(query.addOrderBy).toHaveBeenCalledWith('trip.id', 'DESC');
    const context = historyContext({ before: page.nextCursor! }, 'trips', new Date('2026-10-01'));
    expect(context.cursor?.at).toBe('2026-09-17T12:00:00.123456');
    expect(context.asOf).toBe(now.toISOString());
    await loadHistoryIds(query, { limit: 2 }, context, 'trip.id', 'trip.departureDate');
    expect(query.andWhere).toHaveBeenCalledWith('(trip.departureDate, trip.id) < (:at::timestamp, :cursorId::uuid)',
      { at: rows[1].at, cursorId: rows[1].id });
    expect(orderHistory(page.ids, [{ id: rows[1].id }, { id: rows[0].id }])).toEqual(page.ids.map(id => ({ id })));
  });

  it('rejects bad/cross-list/cross-search cursors; last/empty pages terminate', async () => {
    const { query } = fixture();
    const page = await loadHistoryIds(query, { limit: 2 }, historyContext({ search: 'École' }, 'trips', now), 'trip.id', 'trip.departureDate');
    for (const options of [{ before: 'bad' }, { before: page.nextCursor! }, { before: page.nextCursor!, search: 'other' }]) {
      expect(() => historyContext(options, 'trips')).toThrow('La page demandée est invalide');
    }
    expect(() => historyContext({ before: page.nextCursor!, search: 'ecole' }, 'bookings')).toThrow();
    expect(historyContext({ before: page.nextCursor!, search: 'ecole' }, 'trips').search).toBe('ecole');
    query.getRawMany.mockResolvedValueOnce(rows.slice(0, 1)).mockResolvedValueOnce([]);
    expect((await loadHistoryIds(query, {}, historyContext({}, 'trips'), 'trip.id', 'trip.departureDate')).nextCursor).toBeNull();
    expect((await loadHistoryIds(query, {}, historyContext({}, 'trips'), 'trip.id', 'trip.departureDate')).ids).toEqual([]);
  });

  it('binds search literally, folds French accents and avoids wildcard injection', () => {
    const { query } = fixture();
    applyHistorySearch(query, "100%_! ' OR true --", ['trip.departureLocation']);
    const [sql, params] = query.andWhere.mock.calls[0];
    expect(sql).toContain("ESCAPE '!'"); expect(sql).not.toContain('OR true');
    expect(params.historySearch).toBe("%100!%!_!! ' OR true --%");
    const [source, target] = sql.match(/'à[^']*'| 'aaaa[^']*'/g).map((part: string) => part.trim().slice(1, -1));
    expect(source.length).toBe(target.length);
  });

  it('always scopes histories to their owner and keeps ongoing bookings out of expiration', async () => {
    const { query, repository } = fixture();
    await selectTripHistory(repository, 'driver', {});
    expect(query.where).toHaveBeenCalledWith('trip.driverId = :driverId', { driverId: 'driver' });
    expect(query.andWhere.mock.calls[0][1].closed).toEqual([TripStatus.COMPLETED, TripStatus.CANCELLED]);
    expect(query.andWhere.mock.calls[0][1].upcoming).toBe(TripStatus.PENDING);
    expect(query.leftJoin).not.toHaveBeenCalled();
    query.andWhere.mockClear();
    await selectBookingHistory(repository, 'passenger', { search: 'Lemba' });
    expect(query.where).toHaveBeenCalledWith('booking.passengerId = :passengerId', { passengerId: 'passenger' });
    expect(query.andWhere.mock.calls[0][1].ongoing).toBe(TripStatus.ACTIVE);
    expect(query.andWhere.mock.calls[0][1].closed).toContain(BookingStatus.EXPIRED);
    expect(query.leftJoin.mock.calls.every(([relation]: string[]) => !relation.includes('bookings'))).toBe(true);
  });

  it('validates page limits and input lengths at the HTTP boundary', async () => {
    expect(await validate(plainToInstance(HistoryPageQuery, { limit: '30' }))).toEqual([]);
    for (const limit of ['NaN', '-1', '101', '1.5']) {
      expect((await validate(plainToInstance(HistoryPageQuery, { limit }))).length).toBeGreaterThan(0);
    }
    expect((await validate(plainToInstance(HistoryPageQuery, { search: 'x'.repeat(101) }))).length).toBeGreaterThan(0);
  });
});
