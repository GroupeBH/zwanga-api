'use strict';

// Isolate SQL execution cost from the mixed workload. Fresh local fixtures only;
// no API, Redis, providers, credentials, SQL text or bind values in the output.
process.env.TZ = 'UTC';
const { join } = require('node:path');
const { randomBytes, randomUUID } = require('node:crypto');
const { restrictConnections } = require('../isolation.cjs');
const root = join(__dirname, '../../..');
if (process.argv.length !== 3 || process.argv[2] !== '--execute-local')
  throw new Error('Usage: node test/load/journeys/profile-discovery.cjs --execute-local');
require('ts-node').register({ project: join(root, 'tsconfig.json'), transpileOnly: true });
require('reflect-metadata');
const { IsolatedPostgres } = require('../../isolated-postgres.ts');
const cluster = new IsolatedPostgres(process.env.LOAD_TEST_PG_BIN || 'C:/Program Files/PostgreSQL/18/bin');
const load = name => require(join(root, 'dist', name));

(async () => {
  let network;
  try {
    const db = await cluster.start();
    network = restrictConnections([db.options.port]);
    await require('./time-alignment.cjs').verifyTimeAlignment(db);
    const f = await require('./fixtures.cjs').seed(db, load,
      { maxTrips: 500, availableDrivers: 500, requests: 500 }, randomBytes(32).toString('hex'));
    // Same moving/available drivers as the mixed test, without concurrent writes.
    await db.query(`UPDATE trips SET "currentLocation"="departurePoint", "lastLocationUpdateAt"=now()`);
    await db.query(`INSERT INTO driver_dispatch_presence
      ("driverId","vehicleId","leaseId",seats,position,"expiresAt","updatedAt","discoveryEnabled")
      SELECT "driverId","vehicleId"::uuid,gen_random_uuid(),3,"departurePoint",now()+interval '1 minute',now(),true FROM trips`);
    const request = await db.getRepository(load('trip-requests/entities/trip-request.entity').TripRequest).save({
      passengerId: f.demands[0].passenger.id, immediateDispatch: true, sequentialDispatch: true,
      departureLocation: 'Synthetic pickup', arrivalLocation: 'Synthetic dropoff',
      departurePoint: { type: 'Point', coordinates: [15.31, -4.3] },
      arrivalPoint: { type: 'Point', coordinates: [15.318, -4.3] },
      departureDateMin: new Date(), departureDateMax: new Date(Date.now() + 2400000),
      numberOfSeats: 1, maxPricePerSeat: 2500, vehicleType: 'car', paymentMode: 'cash',
    });
    const requestEntity = load('trip-requests/entities/trip-request.entity').TripRequest;
    const others = f.demands.slice(1).map(d => ({ ...request, id: randomUUID(), passengerId: d.passenger.id }));
    for (let i = 0; i < others.length; i += 100) await db.getRepository(requestEntity).insert(others.slice(i, i + 100));
    const drivers = [...f.availableDrivers, ...f.journeys.map(j => j.driver)];
    const history = [request, ...others].flatMap((r, i) => Array.from({ length: 4 }, (_, slot) => ({
      id: randomUUID(), requestId: r.id, driverId: drivers[(i * 4 + slot) % drivers.length].id,
      vehicleId: drivers[(i * 4 + slot) % drivers.length].vehicleId,
      status: i < 125 && slot < 2 ? 'pending' : 'expired', waveSlot: slot + 1,
    })));
    await db.query(`INSERT INTO trip_request_dispatch_offers
      (id,"requestId","driverId","vehicleId",seats,status,"waveSlot",sequential,"expiresAt")
      SELECT id,"requestId","driverId","vehicleId",3,status,"waveSlot",true,now()+interval '30 seconds'
      FROM jsonb_to_recordset($1::jsonb) AS x(id uuid,"requestId" uuid,"driverId" uuid,"vehicleId" uuid,status text,"waveSlot" integer)`,
    [JSON.stringify(history)]);
    await db.query('ANALYZE');
    const { sequentialCandidates, lockQueuedCandidates } = load('trip-requests/dispatch/sequential-candidates');
    for (const mode of ['discovery', 'queued']) {
      let sql, parameters;
      const capture = { query: async (text, args) => { sql = text; parameters = args; return []; } };
      if (mode === 'discovery') await sequentialCandidates(capture, request);
      else await lockQueuedCandidates(capture, request, f.availableDrivers.slice(0, 50).map(d => d.id), 4);
      for (let run = 0; run < 3; run++) {
        const [row] = await db.query('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' + sql, parameters);
        const plan = row['QUERY PLAN'][0], nodes = [];
        const visit = n => {
          nodes.push({ type: n['Node Type'], relation: n['Relation Name'], index: n['Index Name'],
            loops: n['Actual Loops'], rows: n['Actual Rows'], removed: n['Rows Removed by Filter'],
            ms: n['Actual Total Time'] * n['Actual Loops'] });
          for (const child of n.Plans ?? []) visit(child);
        };
        visit(plan.Plan);
        console.log(JSON.stringify({ mode, run, executionMs: plan['Execution Time'], planningMs: plan['Planning Time'],
          jit: plan.JIT, nodes: nodes.sort((a, b) => b.ms - a.ms).slice(0, 12) }));
      }
    }
    if (network.count()) throw new Error('Unexpected external connection attempt');
  } finally {
    await cluster.stop(); network?.restore();
  }
})().catch(() => { console.error('Isolated discovery diagnostic failed'); process.exitCode = 1; });
