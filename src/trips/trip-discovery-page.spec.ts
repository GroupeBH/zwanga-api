import { discoveryFilterHash, readDiscoveryCursor, selectDiscoveryPage } from './trip-discovery-page';
import { DataSource } from 'typeorm';
import { Trip } from './entities/trip.entity';
import { join } from 'path';

describe('Bounded discovery cursor queries', () => {
  const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const filters = { minSeats: 1, sort: 'price' as const, limit: 2 };
  const fixture = () => {
    const trips = [1, 2, 3].map(n => ({ id: id(n), departureDate: new Date('2026-10-02T12:00:00Z') }));
    const query: any = {}, outer: any = {};
    for (const name of ['andWhere', 'select', 'addSelect', 'orderBy', 'addOrderBy', 'limit']) query[name] = jest.fn().mockReturnValue(query);
    for (const name of ['select', 'from', 'addCommonTableExpression', 'innerJoin', 'leftJoinAndSelect', 'addSelect', 'orderBy', 'addOrderBy']) outer[name] = jest.fn().mockReturnValue(outer);
    query.createQueryBuilder = jest.fn().mockReturnValue(outer);
    outer.getRawAndEntities = jest.fn().mockResolvedValue({ entities: trips,
      raw: trips.map(trip => ({ trip_id: trip.id, discovery_rank: 0, discovery_sort: 2000 })) });
    return { query, outer, trips };
  };
  it('limits SQL before hydration and carries a deterministic UUID tiebreaker', async () => {
    const { query, outer } = fixture();
    const page = await selectDiscoveryPage(query, filters, '0');
    expect(query.limit).toHaveBeenCalledWith(3);
    expect(page.entities).toHaveLength(2);
    expect(page.previousCursor).toBeNull();
    expect(readDiscoveryCursor(page.nextCursor!, discoveryFilterHash(filters))).toMatchObject({ id: id(2), sort: 2000 });
    expect(query.addOrderBy).toHaveBeenCalledWith('trip.id', 'ASC');
    expect(outer.addCommonTableExpression).toHaveBeenCalledWith(query, 'discovery_page', { materialized: true });
    expect(outer.leftJoinAndSelect).toHaveBeenCalledWith('trip.driver', 'driver');
  });
  it('binds cursors to filters and uses parameterized comparisons in both directions', async () => {
    const first = await selectDiscoveryPage(fixture().query, filters, '0');
    expect(() => readDiscoveryCursor(first.nextCursor!, discoveryFilterHash({ ...filters, minSeats: 4 }))).toThrow();
    const { query } = fixture();
    await selectDiscoveryPage(query, { ...filters, cursor: first.nextCursor!, direction: 'previous' }, '0');
    expect(query.andWhere.mock.calls[0][0]).toContain('< (:cursorRank, :cursorSort, :cursorDate, :cursorId)');
    expect(query.andWhere.mock.calls[0][1].cursorDate).toEqual(new Date('2026-10-02T12:00:00Z'));
    expect(query.orderBy).toHaveBeenCalledWith('discovery_rank', 'DESC');
  });
  it('binds the exact timestamp from new cursors without a timezone/precision conversion', async () => {
    const date = '2026-10-02T13:00:00.123456';
    const cursor = Buffer.from(JSON.stringify({ rank: 1, sort: 2000, date: '2026-10-02T12:00:00.123Z',
      at: date, id: id(2), filter: discoveryFilterHash(filters) })).toString('base64url');
    const { query } = fixture();
    await selectDiscoveryPage(query, { ...filters, cursor }, '0');
    expect(query.andWhere.mock.calls[0][1].cursorDate).toBe(date);
    const invalid = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(cursor, 'base64url').toString()), at: 'invalid' })).toString('base64url');
    expect(() => readDiscoveryCursor(invalid, discoveryFilterHash(filters))).toThrow();
  });
  it.each(['2026-02-31T12:00:00.000001', '2026-01-01T24:00:00.000000',
    '2026-13-01T12:00:00.000000', '0000-01-01T12:00:00.000000'])
    ('rejects impossible timestamp %s before SQL execution', at => {
      const cursor = Buffer.from(JSON.stringify({ rank: 0, sort: 2000, date: '2026-01-01T12:00:00Z',
        at, id: id(1), filter: discoveryFilterHash(filters) })).toString('base64url');
      expect(() => readDiscoveryCursor(cursor, discoveryFilterHash(filters))).toThrow();
    });
  it.each(['bad', 'e30=', 'x'.repeat(1025)])('rejects malformed cursors', cursor => {
    expect(() => readDiscoveryCursor(cursor, discoveryFilterHash(filters))).toThrow();
  });
  it('compiles with real PostgreSQL metadata without renaming the entity primary key', async () => {
    const source = new DataSource({ type: 'postgres', entities: [join(__dirname, '../**/*.entity.ts')] });
    // Metadata only: no initialize(), connection, credentials or SQL execution.
    await (source as any).buildMetadatas();
    const query = source.getRepository(Trip).createQueryBuilder('trip')
      .where('trip.isPrivate = :private', { private: false }).setParameter('now', new Date());
    const outer = query.createQueryBuilder();
    jest.spyOn(query, 'createQueryBuilder').mockReturnValue(outer);
    const read = jest.spyOn(outer, 'getRawAndEntities').mockResolvedValue({ entities: [], raw: [] });
    await selectDiscoveryPage(query, filters, '0');
    const [sql, parameters] = outer.getQueryAndParameters();
    expect(sql).toContain('WITH "discovery_page" AS MATERIALIZED');
    expect(sql).toContain('AS "trip_id"');
    expect(sql).not.toContain('"discovery_id"');
    expect(sql).toContain('LIMIT 3');
    expect(sql.indexOf('LIMIT 3')).toBeLessThan(sql.indexOf('LEFT JOIN "users"'));
    expect(sql.indexOf('LIMIT 3')).toBeLessThan(sql.indexOf('LEFT JOIN "vehicles"'));
    expect(sql).toContain('"trip"."pricePerSeat"::double precision');
    expect(parameters).toContain(false);
    expect(read).toHaveBeenCalledTimes(1);
  });
});
