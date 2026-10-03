import { discoveryFilterHash, readDiscoveryCursor, selectDiscoveryPage } from './trip-discovery-page';
import { DataSource } from 'typeorm';
import { Trip } from './entities/trip.entity';
import { join } from 'path';

describe('Bounded discovery cursor queries', () => {
  const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const filters = { minSeats: 1, sort: 'price' as const, limit: 2 };
  const fixture = () => {
    const trips = [1, 2, 3].map(n => ({ id: id(n), departureDate: new Date('2026-10-02T12:00:00Z') }));
    const query: any = {};
    for (const name of ['andWhere', 'addSelect', 'orderBy', 'addOrderBy', 'limit']) query[name] = jest.fn().mockReturnValue(query);
    query.getRawAndEntities = jest.fn().mockResolvedValue({ entities: trips,
      raw: trips.map(trip => ({ trip_id: trip.id, discovery_rank: 0, discovery_sort: 2000 })) });
    return { query, trips };
  };
  it('limits SQL before hydration and carries a deterministic UUID tiebreaker', async () => {
    const { query } = fixture();
    const page = await selectDiscoveryPage(query, filters, '0');
    expect(query.limit).toHaveBeenCalledWith(3);
    expect(page.entities).toHaveLength(2);
    expect(page.previousCursor).toBeNull();
    expect(readDiscoveryCursor(page.nextCursor!, discoveryFilterHash(filters))).toMatchObject({ id: id(2), sort: 2000 });
    expect(query.addOrderBy).toHaveBeenCalledWith('trip.id', 'ASC');
  });
  it('binds cursors to filters and uses parameterized comparisons in both directions', async () => {
    const first = await selectDiscoveryPage(fixture().query, filters, '0');
    expect(() => readDiscoveryCursor(first.nextCursor!, discoveryFilterHash({ ...filters, minSeats: 4 }))).toThrow();
    const { query } = fixture();
    await selectDiscoveryPage(query, { ...filters, cursor: first.nextCursor!, direction: 'previous' }, '0');
    expect(query.andWhere.mock.calls[0][0]).toContain('< (:cursorRank, :cursorSort, :cursorDate, :cursorId)');
    expect(query.orderBy).toHaveBeenCalledWith('discovery_rank', 'DESC');
  });
  it.each(['bad', 'e30=', 'x'.repeat(1025)])('rejects malformed cursors', cursor => {
    expect(() => readDiscoveryCursor(cursor, discoveryFilterHash(filters))).toThrow();
  });
  it('compiles with real PostgreSQL metadata without renaming the entity primary key', async () => {
    const source = new DataSource({ type: 'postgres', entities: [join(__dirname, '../**/*.entity.ts')] });
    // Metadata only: no initialize(), connection, credentials or SQL execution.
    await (source as any).buildMetadatas();
    const query = source.getRepository(Trip).createQueryBuilder('trip')
      .leftJoinAndSelect('trip.driver', 'driver').leftJoinAndSelect('trip.vehicle', 'vehicle')
      .where('trip.isPrivate = :private', { private: false }).setParameter('now', new Date());
    const read = jest.spyOn(query, 'getRawAndEntities').mockResolvedValue({ entities: [], raw: [] });
    await selectDiscoveryPage(query, filters, '0');
    const [sql, parameters] = query.getQueryAndParameters();
    expect(sql).toContain('AS "trip_id"');
    expect(sql).not.toContain('"discovery_id"');
    expect(sql).toContain('LIMIT 3');
    expect(sql).toContain('"trip"."pricePerSeat"::double precision');
    expect(parameters).toContain(false);
    expect(read).toHaveBeenCalledTimes(1);
  });
});
