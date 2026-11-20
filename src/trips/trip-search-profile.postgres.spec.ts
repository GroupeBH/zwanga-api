import { DataSource } from 'typeorm';
import { IsolatedPostgres } from '../../test/isolated-postgres';
import { typeOrmEntities } from '../database/entities';
import { Trip } from './entities/trip.entity';
import { TripsService } from './trips.service';
import { discoveryDepartureWithinSql } from './discovery-geography';

const bin = process.env.TRIP_SEARCH_TEST_POSTGRES_BIN;
(bin ? describe : describe.skip)('synthetic discovery plan (never production)', () => {
  jest.setTimeout(120000);
  const cluster = new IsolatedPostgres(bin!);
  let db: DataSource;
  beforeAll(async () => {
    const setupStarted = performance.now();
    const phase = (stage: string) => process.stdout.write(JSON.stringify({
      event: 'synthetic_discovery_setup', stage, elapsedMs: Math.round(performance.now() - setupStarted),
    }) + '\n');
    db = await cluster.start();
    phase('cluster_started');
    expect(await db.query('SHOW fsync')).toEqual([{ fsync: 'on' }]);
    db.setOptions({ entities: typeOrmEntities });
    await (db as any).buildMetadatas();
    await db.query('CREATE EXTENSION postgis; CREATE EXTENSION "uuid-ossp"');
    await db.synchronize();
    phase('schema_created');
    await db.query(`INSERT INTO users(id,"firstName","lastName")
      SELECT md5('profile-user-'||n)::uuid,'Synthetic','Driver' FROM generate_series(1,5000) n;
      INSERT INTO trips("driverId","departureLocation","arrivalLocation","departureDate",
        "availableSeats","pricePerSeat","departurePoint","arrivalPoint",status,"currentLocation","lastLocationUpdateAt")
      SELECT id,'Synthetic A','Synthetic B','2099-01-01',3,2500,
        ST_SetSRID(ST_MakePoint(15.28+CASE WHEN n%100=0 THEN 0 ELSE 1 END,-4.34),4326),
        ST_SetSRID(ST_MakePoint(15.28,-4.34),4326),
        (CASE WHEN n%7=0 THEN 'ongoing' ELSE 'upcoming' END)::trips_status_enum,
        ST_SetSRID(ST_MakePoint(15.28+CASE WHEN n%50=0 THEN 0 ELSE 1 END,-4.34),4326),
        CASE WHEN n%3=0 THEN now() ELSE now()-interval '5 minutes' END
      FROM (SELECT id,row_number() OVER (ORDER BY id) n FROM users) u;
      ANALYZE users; ANALYZE trips; ANALYZE vehicles; ANALYZE subscriptions;`);
    phase('5000_trips_seeded');
  // Bootstrap/seed time is not a query latency measurement. Keep the actual
  // EXPLAIN statement budget below at 10 seconds, independently of setup.
  }, 300000);
  afterAll(() => cluster.stop());

  it('profiles the actual query with bounded synthetic data and preserves eligibility', async () => {
    let statement: string | undefined, parameters: any[] | undefined;
    const spy = jest.spyOn(db.logger, 'logQuery').mockImplementation((sql, args) => {
      if (sql.startsWith('WITH "discovery_page"')) { statement = sql; parameters = args; }
    });
    const service = Object.assign(Object.create(TripsService.prototype), {
      logger: { log: jest.fn(), debug: jest.fn(), warn: jest.fn() },
      tripRepository: db.getRepository(Trip), buildUserRatingsMap: async () => new Map(),
      subscriptionsService: { getPremiumFeaturesForUsers: async () => new Map() },
      sanitizeTrip: async (trip: Trip) => trip, sortSanitizedTripsByPremium: (trips: Trip[]) => trips,
    });
    const result = await service.searchPage({ departureCoordinates: [15.28,-4.34], departureRadiusKm: 1, limit: 20 });
    spy.mockRestore();
    expect(result.data).toHaveLength(20);
    expect(statement).toBeDefined();
    const optimizedStatement = statement!, optimizedParameters = parameters;
    const repo = db.getRepository(Trip);
    const build = repo.createQueryBuilder.bind(repo);
    const querySpy = jest.spyOn(repo, 'createQueryBuilder').mockImplementation((...args: any[]) => {
      const query = build(...args as [string]);
      const andWhere = query.andWhere.bind(query);
      query.andWhere = ((where: any, values?: any) => andWhere(where === discoveryDepartureWithinSql
        ? `ST_DWithin(${service.getDepartureSearchPointExpression()}, ST_SetSRID(ST_MakePoint(:depLng,:depLat),4326)::geography,:depRadius)`
        : where, values)) as any;
      return query;
    });
    const legacySpy = jest.spyOn(db.logger, 'logQuery').mockImplementation((sql, args) => {
      if (sql.startsWith('WITH "discovery_page"')) { statement = sql; parameters = args; }
    });
    const legacy = await service.searchPage({ departureCoordinates: [15.28,-4.34], departureRadiusKm: 1, limit: 20 });
    querySpy.mockRestore(); legacySpy.mockRestore();
    expect(result.data.map((trip: Trip) => trip.id)).toEqual(legacy.data.map((trip: Trip) => trip.id));
    const runner = db.createQueryRunner();
    try {
      await runner.startTransaction();
      await runner.query("SET LOCAL statement_timeout='10s'");
      for (const [variant, sql, args] of [['legacy',statement,parameters], ['optimized',optimizedStatement,optimizedParameters]] as const) {
      const [row] = await runner.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, args);
      const plan = row['QUERY PLAN'][0];
      const nodes: any[] = [];
      const walk = (node: any) => { nodes.push({ type: node['Node Type'], relation: node['Relation Name'],
        index: node['Index Name'], rows: node['Actual Rows'], loops: node['Actual Loops'], removed: node['Rows Removed by Filter'] });
        for (const child of node.Plans ?? []) walk(child); };
      walk(plan.Plan);
      process.stdout.write(JSON.stringify({ event: 'synthetic_discovery_plan', variant, executionMs: plan['Execution Time'],
        planningMs: plan['Planning Time'], jit: plan.JIT, nodes })+'\n');
      }
      await runner.rollbackTransaction();
    } finally { await runner.release(); }
  });
});
