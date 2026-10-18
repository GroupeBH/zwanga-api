import { BadRequestException } from '@nestjs/common';
import { createHash } from 'crypto';
import { isUUID } from 'class-validator';
import { SelectQueryBuilder } from 'typeorm';
import { Trip } from './entities/trip.entity';
import { SearchTripsDto } from './dto/trip.dto';

type Cursor = { rank: number; sort: number; date: string; at?: string; id: string; filter: string };
const rankSql = `CASE WHEN COALESCE((SELECT s."featuredTripsEnabled" FROM subscriptions s
  WHERE s."userId" = trip."driverId" AND s.status = 'active' AND s."endDate" > :now
  ORDER BY s."createdAt" DESC LIMIT 1), false) THEN 0 ELSE 1 END`;

export function discoveryFilterHash(filters: SearchTripsDto) {
  return createHash('sha256').update(JSON.stringify(Object.keys(filters).sort()
    .filter(key => !['cursor', 'limit', 'direction'].includes(key) && filters[key] !== undefined)
    .map(key => [key, filters[key]]))).digest('hex');
}
export function readDiscoveryCursor(value: string, filter: string): Cursor {
  try {
    if (value.length > 1024) throw new Error();
    const cursor = JSON.parse(Buffer.from(value, 'base64url').toString()) as Cursor;
    if (![0, 1].includes(cursor.rank) || !Number.isFinite(cursor.sort) || !isUUID(cursor.id) ||
        typeof cursor.date !== 'string' || !Number.isFinite(Date.parse(cursor.date)) || cursor.filter !== filter) throw new Error();
    if (cursor.at !== undefined && (typeof cursor.at !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}$/.test(cursor.at) ||
        cursor.at.startsWith('0000') ||
        // Reject impossible calendar values before binding a PostgreSQL timestamp.
        new Date(`${cursor.at}Z`).toISOString().slice(0, 23) !== cursor.at.slice(0, 23))) throw new Error();
    return cursor;
  } catch { throw new BadRequestException('Page de recherche invalide. Relancez la recherche.'); }
}
export async function selectDiscoveryPage(query: SelectQueryBuilder<Trip>, filters: SearchTripsDto, nearbyOrder: string) {
  const limit = Math.min(50, Math.max(1, Math.trunc(filters.limit ?? 30)));
  const filter = discoveryFilterHash(filters);
  const backwards = filters.direction === 'previous' && Boolean(filters.cursor);
  const order = backwards ? 'DESC' : 'ASC';
  const sortSql = filters.sort === 'price' ? '"trip"."pricePerSeat"::double precision'
    : filters.sort === 'date' ? 'EXTRACT(EPOCH FROM trip.departureDate)::double precision' : nearbyOrder;
  if (filters.cursor) {
    const cursor = readDiscoveryCursor(filters.cursor, filter);
    query.andWhere(`(${rankSql}, ${sortSql}, trip.departureDate, trip.id) ${backwards ? '<' : '>'} (:cursorRank, :cursorSort, :cursorDate, :cursorId)`,
      // New cursors preserve the exact timestamp-without-time-zone value.
      // Older ISO cursors still work: pg serializes Date in the same timezone
      // as entity writes, unlike an ISO string cast directly to timestamp.
      { cursorRank: cursor.rank, cursorSort: cursor.sort, cursorDate: cursor.at ?? new Date(cursor.date), cursorId: cursor.id });
  }
  // Select a bounded page before joining/hydrating drivers and vehicles. A
  // materialized CTE keeps inaccurate geographic row estimates from causing
  // thousands of repeated relation scans. One statement keeps one snapshot.
  const candidates = query.select('trip.id', 'id')
    .addSelect(rankSql, 'discovery_rank').addSelect(sortSql, 'discovery_sort')
    .addSelect(`to_char(trip.departureDate, 'YYYY-MM-DD"T"HH24:MI:SS.US')`, 'discovery_date')
    .orderBy('discovery_rank', order).addOrderBy('discovery_sort', order)
    .addOrderBy('trip.departureDate', order).addOrderBy('trip.id', order).limit(limit + 1);
  const result = await query.createQueryBuilder().select('trip').from(Trip, 'trip')
    .addCommonTableExpression(candidates, 'discovery_page', { materialized: true })
    .innerJoin('discovery_page', 'page', 'page.id = trip.id')
    .leftJoinAndSelect('trip.driver', 'driver').leftJoinAndSelect('trip.vehicle', 'vehicle')
    .addSelect('page.discovery_rank', 'discovery_rank').addSelect('page.discovery_sort', 'discovery_sort')
    .addSelect('page.discovery_date', 'discovery_date')
    .orderBy('page.discovery_rank', order).addOrderBy('page.discovery_sort', order)
    .addOrderBy('trip.departureDate', order).addOrderBy('trip.id', order).getRawAndEntities();
  const entities = result.entities.slice(0, limit);
  if (backwards) entities.reverse();
  const encode = (trip: Trip | undefined) => {
    // Keep TypeORM's native primary-key alias: renaming it breaks entity hydration.
    const raw = trip && result.raw.find(row => row.trip_id === trip.id);
    return raw && trip ? Buffer.from(JSON.stringify({ rank: Number(raw.discovery_rank), sort: Number(raw.discovery_sort),
      date: trip.departureDate.toISOString(), at: raw.discovery_date, id: trip.id, filter } satisfies Cursor)).toString('base64url') : null;
  };
  const more = result.entities.length > limit;
  return { entities, nextCursor: (backwards ? !!filters.cursor : more) ? encode(entities.at(-1)) : null,
    previousCursor: (backwards ? more : !!filters.cursor) ? encode(entities[0]) : null };
}
