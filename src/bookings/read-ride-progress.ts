import type { EntityMetadata, Repository } from 'typeorm';
import { Booking, BookingStatus } from './entities/booking.entity';
import { Trip } from '../trips/entities/trip.entity';
import { User } from '../users/entities/user.entity';
import { FreshReadBatch } from '../common/fresh-read-batch';
import { copySqlProjection } from '../common/utils/copy-sql-projection';
import { backgroundSql } from '../database/background-sql-budget';

type Column = EntityMetadata['columns'][number];
type Projection = { metadata: EntityMetadata; columns: { column: Column; alias: string }[] };
type ReadPlan = { sql: string; booking: Projection; trip: Projection; passenger: Projection };
const plans = new WeakMap<Repository<Booking>, ReadPlan>();
const readers = new WeakMap<Repository<Booking>, FreshReadBatch<string, Record<string, unknown>[]>>();
const passengerFields = new Set(['id', 'firstName', 'lastName']);

/** Only SQL structure is memoized, never rows, GPS, status or permissions.
 * Keep all normally selected booking/trip columns: automatic completion still
 * uses their financial snapshots. Hidden declarations must remain unselected.
 * The passenger relation is only a name for notifications; authorization/KYC and
 * delivery tokens continue to be read by their existing dedicated services.
 * These three entities have no after-load listeners or eager relations.
 */
function buildPlan(repository: Repository<Booking>): ReadPlan {
  const connection = repository.manager.connection;
  const quote = (name: string) => connection.driver.escape(name);
  const select: string[] = [];
  const project = (metadata: EntityMetadata, prefix: string, fields?: Set<string>): Projection => {
    const columns = metadata.columns.filter(column => column.isSelect &&
      !column.isVirtual && !column.isVirtualProperty && (!fields || fields.has(column.propertyName)))
      .map((column, index) => {
        const alias = `${prefix}${index}`;
        const expression = `${prefix}.${quote(column.databaseName)}`;
        const value = column.type === 'geography' || column.type === 'geometry'
          ? `ST_AsGeoJSON(${expression})::json` : expression;
        select.push(`${value} AS ${quote(alias)}`);
        return { column, alias };
      });
    return { metadata, columns };
  };
  const booking = project(repository.metadata, 'b');
  const trip = project(connection.getMetadata(Trip), 't');
  const passenger = project(connection.getMetadata(User), 'u', passengerFields);
  const table = (projection: Projection) => projection.metadata.tablePath.split('.').map(quote).join('.');
  return {
    booking, trip, passenger,
    sql: `SELECT ${select.join(', ')} FROM ${table(booking)} b
      LEFT JOIN ${table(trip)} t ON t.id=b."tripId"
      LEFT JOIN ${table(passenger)} u ON u.id=b."passengerId"
      WHERE b."tripId"=ANY($1::uuid[]) AND b.status IN ($2,$3,$4)`,
  };
}

export async function readRideProgressBookings(repository: Repository<Booking>, tripId: string): Promise<Booking[]> {
  let plan = plans.get(repository);
  if (!plan) { plan = buildPlan(repository); plans.set(repository, plan); }
  let reader = readers.get(repository);
  if (!reader) {
    const readPlan = plan;
    const tripAlias = readPlan.booking.columns.find(({ column }) => column.propertyName === 'tripId')!.alias;
    reader = new FreshReadBatch(async ids => {
      const rows: Record<string, unknown>[] = await backgroundSql(repository.manager, 'progress', () =>
        repository.query(readPlan.sql, [[...new Set(ids)],
          BookingStatus.ACCEPTED, BookingStatus.NO_SHOW, BookingStatus.BOARDING_UNCERTAIN]));
      const byTrip = new Map<string, Record<string, unknown>[]>();
      for (const row of rows) {
        const id = row[tripAlias] as string;
        const group = byTrip.get(id) ?? [];
        group.push(row);
        byTrip.set(id, group);
      }
      return ids.map(id => copySqlProjection(byTrip.get(id) ?? []));
    });
    readers.set(repository, reader);
  }
  const rows = await reader.load(tripId.toLowerCase());
  const hydrate = (projection: Projection, row: Record<string, unknown>) => {
    const primary = projection.columns.find(({ column }) => column.isPrimary)!;
    if (row[primary.alias] === null) return null; // Preserve LEFT JOIN semantics.
    const entity = projection.metadata.create();
    for (const { column, alias } of projection.columns)
      column.setEntityValue(entity, repository.manager.connection.driver.prepareHydratedValue(row[alias], column));
    return entity;
  };
  return rows.map((row: Record<string, unknown>) => {
    const booking: Booking = hydrate(plan!.booking, row);
    booking.trip = hydrate(plan!.trip, row);
    booking.passenger = hydrate(plan!.passenger, row);
    return booking;
  });
}
