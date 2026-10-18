import { DataSource } from 'typeorm';
import { IsolatedPostgres } from '../../test/isolated-postgres';
import { typeOrmEntities } from '../database/entities';
import { User } from '../users/entities/user.entity';
import { Vehicle } from '../vehicles/entities/vehicle.entity';
import { Trip, TripStatus } from './entities/trip.entity';
import { Subscription } from '../subscriptions/entities/subscription.entity';
import { TripsService } from './trips.service';

const bin = process.env.TRIP_SEARCH_TEST_POSTGRES_BIN;
(bin ? describe : describe.skip)('geographic discovery on disposable PostgreSQL/PostGIS', () => {
  const cluster = new IsolatedPostgres(bin!);
  let db: DataSource;
  let service: TripsService;
  const near = { type: 'Point' as const, coordinates: [15.28, -4.34] };
  const far = { type: 'Point' as const, coordinates: [16.28, -5.34] };
  const filters = { departureCoordinates: [15.28, -4.34] as [number, number], departureRadiusKm: 1 };

  beforeAll(async () => {
    db = await cluster.start();
    await db.destroy();
    db.setOptions({ entities: typeOrmEntities });
    await db.initialize();
    await db.query('CREATE EXTENSION IF NOT EXISTS postgis');
    await db.synchronize();
    service = Object.assign(Object.create(TripsService.prototype), {
      logger: { log: jest.fn(), debug: jest.fn() }, tripRepository: db.getRepository(Trip),
      buildUserRatingsMap: async () => new Map(),
      subscriptionsService: { getPremiumFeaturesForUsers: async () => new Map() },
      // Keep actual query, hydration and cursor logic. Only skip external/presentation enrichment.
      sanitizeTrip: async (trip: Trip) => trip,
      sortSanitizedTripsByPremium: (trips: Trip[]) => trips,
    });
  }, 120000);
  afterAll(() => cluster.stop(), 40000);
  beforeEach(async () => { await db.query('TRUNCATE users CASCADE'); });

  async function trip(overrides: Partial<Trip> = {}) {
    const user = await db.getRepository(User).save({ firstName: 'Synthetic', lastName: 'Driver' });
    return db.getRepository(Trip).save({ driverId: user.id, departureLocation: 'Test departure',
      arrivalLocation: 'Test arrival', departurePoint: near, arrivalPoint: near,
      departureDate: new Date('2099-01-01T12:00:00Z'), totalSeats: 4, availableSeats: 2, pricePerSeat: 1000,
      ...overrides });
  }

  it('preserves GPS freshness, nullable locations, visibility, seats and future departure rules', async () => {
    const fresh = new Date(), stale = new Date(Date.now() - 120000);
    const fixtures = await Promise.all([
      trip(),
      trip({ currentLocation: far, lastLocationUpdateAt: fresh }), // upcoming ignores GPS
      trip({ status: TripStatus.ACTIVE, departurePoint: far, currentLocation: near, lastLocationUpdateAt: fresh }),
      trip({ status: TripStatus.ACTIVE, currentLocation: far, lastLocationUpdateAt: stale }),
      trip({ status: TripStatus.ACTIVE, currentLocation: null, lastLocationUpdateAt: fresh }),
      trip({ status: TripStatus.ACTIVE, departurePoint: null, currentLocation: near, lastLocationUpdateAt: fresh }),
      trip({ status: TripStatus.ACTIVE, currentLocation: far, lastLocationUpdateAt: fresh }), // not near anymore
      trip({ status: TripStatus.ACTIVE, departurePoint: far, currentLocation: near, lastLocationUpdateAt: stale }),
      trip({ status: TripStatus.ACTIVE, departurePoint: far, currentLocation: near, lastLocationUpdateAt: null }),
      trip({ departurePoint: null }),
      trip({ isPrivate: true }),
      trip({ departureDate: new Date('2000-01-01') }),
      trip({ status: TripStatus.COMPLETED }),
      trip({ status: TripStatus.CANCELLED }),
      trip({ status: TripStatus.ACTIVE, availableSeats: 0 }),
    ]);
    const result = await service.searchPage(filters);
    expect(result.data.map(t => t.id).sort()).toEqual(fixtures.slice(0, 6).map(t => t.id).sort());
    // Independent legacy CASE reference on this same fixture guards query equivalence.
    const legacy = await db.query(`SELECT id FROM trips trip WHERE "isPrivate"=false AND
      ((status='upcoming' AND "departureDate">now()) OR (status='ongoing' AND "availableSeats">0))
      AND ST_DWithin(CASE WHEN status='ongoing' AND "lastLocationUpdateAt">=now()-interval '90 seconds'
        THEN COALESCE("currentLocation","departurePoint") ELSE "departurePoint" END,
        ST_SetSRID(ST_MakePoint($1,$2),4326)::geography,$3)`, [15.28, -4.34, 1000]);
    expect(result.data.map(t => t.id).sort()).toEqual(legacy.map((row: { id: string }) => row.id).sort());
  });

  it('keeps arrival-only, combined coordinates, price and seat filters working', async () => {
    const inside = await trip();
    const outsideDeparture = await trip({ departurePoint: far });
    await trip({ arrivalPoint: far });
    await trip({ pricePerSeat: 2500 });
    await trip({ availableSeats: 1 });
    const arrival = { arrivalCoordinates: [15.28, -4.34] as [number, number], arrivalRadiusKm: 1, minSeats: 2, maxPrice: 1000 };
    expect((await service.searchPage(arrival)).data.map(t => t.id).sort())
      .toEqual([inside.id, outsideDeparture.id].sort());
    expect((await service.searchPage({ ...arrival, ...filters })).data.map(t => t.id)).toEqual([inside.id]);
  });

  it('loads driver/vehicle relations in one bounded statement, also without coordinates', async () => {
    const first = await trip({ departureLocation: 'Gombe test' });
    const second = await trip({ departureLocation: 'Gombe test' });
    const vehicle = await db.getRepository(Vehicle).save({ ownerId: first.driverId,
      brand: 'Synthetic', model: 'Test', color: 'white', licensePlate: 'LOAD-TEST' });
    await db.getRepository(Trip).update(first.id, { vehicleId: vehicle.id });
    await trip({ departureLocation: 'Gombe test', isPrivate: true });
    await trip({ departureLocation: 'Unrelated', arrivalLocation: 'Unrelated' });
    const sql = jest.spyOn(db.logger, 'logQuery');
    try {
      const result = await service.searchPage({ keywords: 'Gombe', sort: 'date', limit: 2 });
      expect(result.data.map(t => t.id).sort()).toEqual([first.id, second.id].sort());
      expect(result.data.find(t => t.id === first.id)).toMatchObject({
        driver: { id: first.driverId, firstName: 'Synthetic' }, vehicle: { id: vehicle.id, brand: 'Synthetic' },
      });
      expect(result.data.find(t => t.id === second.id)?.vehicle).toBeNull();
      expect(result.nextCursor).toBeNull();
      expect(sql).toHaveBeenCalledTimes(1);
      expect(sql.mock.calls[0][0]).toContain('WITH "discovery_page" AS MATERIALIZED');
    } finally { sql.mockRestore(); }
  });

  it('preserves premium precedence and forward/backward cursor order with geo filters', async () => {
    const created = [] as Trip[];
    for (let i = 0; i < 7; i++) created.push(await trip({ pricePerSeat: 1000 + i * 100 }));
    await db.getRepository(Subscription).save({ userId: created[6].driverId,
      startDate: new Date('2026-01-01'), endDate: new Date('2099-01-01'), amount: 5000, currency: 'CDF' });
    const options = { ...filters, limit: 2, sort: 'price' as const };
    const first = await service.searchPage(options);
    expect(first.data.map(t => t.id)).toEqual([created[6].id, created[0].id]);
    const second = await service.searchPage({ ...options, cursor: first.nextCursor! });
    expect(second.data.map(t => t.id)).toEqual([created[1].id, created[2].id]);
    const legacy = JSON.parse(Buffer.from(first.nextCursor!, 'base64url').toString());
    delete legacy.at;
    const legacyPage = await service.searchPage({ ...options, cursor: Buffer.from(JSON.stringify(legacy)).toString('base64url') });
    expect(legacyPage.data.map(t => t.id)).toEqual(second.data.map(t => t.id));
    const previous = await service.searchPage({ ...options, cursor: second.previousCursor!, direction: 'previous' });
    expect(previous.data.map(t => t.id)).toEqual(first.data.map(t => t.id));
    const all = [...first.data, ...second.data];
    let cursor = second.nextCursor;
    while (cursor) {
      const page = await service.searchPage({ ...options, cursor });
      all.push(...page.data); cursor = page.nextCursor;
    }
    expect(all).toHaveLength(7);
    expect(new Set(all.map(t => t.id)).size).toBe(7);
  });

  it('does not repeat a boundary trip when PostgreSQL retains microseconds', async () => {
    const fixtures = [await trip(), await trip(), await trip()];
    for (let i = 0; i < fixtures.length; i++) {
      await db.query(`UPDATE trips SET "departureDate"=$2::timestamp WHERE id=$1`,
        [fixtures[i].id, `2099-01-01T12:00:00.00000${i + 1}`]);
    }
    const options = { ...filters, sort: 'price' as const, limit: 1 };
    const first = await service.searchPage(options);
    const second = await service.searchPage({ ...options, cursor: first.nextCursor! });
    const third = await service.searchPage({ ...options, cursor: second.nextCursor! });
    expect([first, second, third].map(page => page.data[0].id)).toEqual(fixtures.map(t => t.id));
    expect(third.nextCursor).toBeNull();
  });

  it('keeps the 30-result default and global premium precedence when populating the list cache', async () => {
    const fixtures: Trip[] = [];
    for (let i = 1; i <= 31; i++) fixtures.push(await trip({
      departureDate: new Date(`2099-01-${String(i).padStart(2, '0')}T12:00:00Z`),
    }));
    const premium = fixtures[30];
    await db.getRepository(Subscription).save({ userId: premium.driverId,
      startDate: new Date('2026-01-01'), endDate: new Date('2099-02-01'), amount: 5000, currency: 'CDF' });
    const cache = { get: jest.fn().mockResolvedValue(undefined), set: jest.fn() };
    Object.assign(service, { cacheService: cache, CACHE_TTL: 300 });
    const before = await service.search({});
    const after = await service.findAll();
    expect(after).toHaveLength(30);
    expect(after.map(t => t.id)).toEqual(before.map(t => t.id));
    expect(after[0].id).toBe(premium.id);
    cache.get.mockResolvedValue(JSON.parse(JSON.stringify(after)));
    const sql = jest.spyOn(db.logger, 'logQuery');
    try {
      expect((await service.findAll()).map(t => t.id)).toEqual(after.map(t => t.id));
      expect(sql).not.toHaveBeenCalled();
    } finally { sql.mockRestore(); }
  });
});
