import 'reflect-metadata';
import { DataSource, SelectQueryBuilder } from 'typeorm';
import { join } from 'node:path';
import { Booking } from '../bookings/entities/booking.entity';
import { Trip } from '../trips/entities/trip.entity';
import { TripRequest } from '../trip-requests/entities/trip-request.entity';
import { ActivityController } from './activity.controller';
import { ActivityService } from './activity.service';
import { activityRevision, trackingBookingId } from './activity.model';

describe('account activity fingerprints', () => {
  it('is stable across row order, joined duplicates and empty reads', () => {
    const a = { id: 'a', status: 'accepted' }, b = { id: 'b', payment: 'pending' };
    expect(activityRevision([a, b, a])).toEqual(activityRevision([b, { status: 'accepted', id: 'a' }]));
    expect(activityRevision([a, b]).count).toBe(2);
    expect(activityRevision([])).toEqual(activityRevision([]));
    expect(activityRevision([{ ...a, status: 'completed' }]).revision).not.toBe(activityRevision([a]).revision);
  });

  it('pre-arms without needing a booking write and never tracks an already dropped passenger', () => {
    const now = Date.parse('2026-09-22T10:00:00Z');
    const future = { id: 'future', status: 'accepted', tripStatus: 'upcoming', departureDate: new Date(now + 2 * 60 * 60_000 + 1) };
    expect(trackingBookingId([future], now)).toBeNull();
    expect(trackingBookingId([future], now + 1)).toBe('future');
    const ongoing = { ...future, id: 'ongoing', tripStatus: 'ongoing' };
    expect(trackingBookingId([future, ongoing], now + 1)).toBe('ongoing');
    expect(trackingBookingId([{ ...ongoing, droppedOff: true }], now)).toBeNull();
    expect(trackingBookingId([{ ...ongoing, droppedOffConfirmedByPassenger: true }], now)).toBeNull();
  });

  it('takes account identity only from the authenticated request', async () => {
    const read = jest.fn(async userId => ({ userId }));
    const controller = new ActivityController({ read } as unknown as ActivityService);
    expect(await controller.read({ user: { userId: 'account-a' } })).toEqual({ userId: 'account-a' });
    expect(read).toHaveBeenCalledWith('account-a');
  });
});

describe('activity database projections (metadata only; no database connection)', () => {
  let source: DataSource;
  beforeAll(async () => {
    source = new DataSource({ type: 'postgres', database: 'metadata_only',
      entities: [join(__dirname, '..', '**', '*.entity.ts')] });
    await (source as unknown as { buildMetadatas(): Promise<void> }).buildMetadatas();
  });
  afterEach(() => jest.restoreAllMocks());

  it('builds three account-scoped projections, excludes GPS/history payload and returns a tiny idle response', async () => {
    const queries: Array<[string, unknown[]]> = [];
    jest.spyOn(SelectQueryBuilder.prototype, 'getRawMany').mockImplementation(async function (this: SelectQueryBuilder<Trip>) {
      queries.push(this.getQueryAndParameters()); return [];
    });
    const service = new ActivityService(source.getRepository(Trip), source.getRepository(Booking), source.getRepository(TripRequest));
    const snapshot = await service.read('account-a');
    expect(queries).toHaveLength(3);
    for (const [sql, parameters] of queries) {
      expect(parameters).toContain('account-a');
      expect(sql).not.toContain('.*');
      expect(sql).not.toMatch(/currentLocation|passengerCurrentLocation|lastLocationUpdateAt|passengerLastLocationUpdateAt|password|fareQuote/);
      // TypeORM resolves real column properties into quoted SQL, including relation paths.
      expect(sql).not.toMatch(/\b(trip|booking|request|offer|confirmation|driverInterruption|passengerInterruption)\.[a-zA-Z]/);
    }
    expect(snapshot).toMatchObject({ schemaVersion: 1, userId: 'account-a',
      trips: { count: 0 }, bookings: { count: 0 }, requests: { count: 0 },
      hasLiveActivity: false, passengerTrackingBookingId: null });
    expect(JSON.stringify(snapshot).length).toBeLessThan(700);
  });

  it('keeps active rides, payment initiation and interrupted/recent bookings in discovery', async () => {
    const calls: string[] = [];
    jest.spyOn(SelectQueryBuilder.prototype, 'getRawMany').mockImplementation(async function (this: SelectQueryBuilder<Trip>) {
      calls.push(this.getQuery());
      return this.alias === 'booking' ? [{ id: 'pending-payment', status: 'completed', paymentStatus: 'initiated', tripStatus: 'completed' }] : [];
    });
    const service = new ActivityService(source.getRepository(Trip), source.getRepository(Booking), source.getRepository(TripRequest));
    const snapshot = await service.read('account-a');
    expect(snapshot.hasLiveActivity).toBe(true);
    expect(snapshot.bookings.count).toBe(1);
    expect(snapshot.passengerTrackingBookingId).toBeNull();
    const bookings = calls.find(sql => sql.includes('AS') && sql.includes('driver_trip_interruption_confirmations'));
    expect(bookings).toBeDefined();
  });
});
