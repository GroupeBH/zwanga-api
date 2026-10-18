'use strict';

// Only run as a child of run.cjs: no .env, no shared database, no real credentials.
const { join, resolve } = require('node:path');
const { existsSync } = require('node:fs');
const { monitorEventLoopDelay, performance } = require('node:perf_hooks');
const { restrictConnections } = require('./isolation.cjs');
if (!process.send || process.env.ZWANGA_ISOLATED_LOAD !== '1' ||
    existsSync(join(process.cwd(), '.env')) || existsSync(resolve('..', '.env'))) {
  throw new Error('Use test/load/run.cjs to create an isolated environment first');
}
const guard = restrictConnections([process.env.DATABASE_PORT, process.env.REDIS_PORT]);
const dist = process.env.LOAD_TEST_BUILD_DIR || resolve(__dirname, '../../dist');
const load = path => require(join(dist, path));
require('reflect-metadata');
const { DataSource } = require('typeorm');
const { Test } = require('@nestjs/testing');
const { ValidationPipe, Logger } = require('@nestjs/common');
const { JwtService } = require('@nestjs/jwt');
const { ScheduleExplorer } = require('@nestjs/schedule/dist/schedule.explorer');
const { typeOrmEntities } = load('database/entities');
const { tokenFingerprint } = load('auth/token-fingerprint');
const { randomUUID } = require('node:crypto');
let app, db, loop, timer, closing = false;
let queryCount = 0;
const queries = new Map();
let discoverySample;
let cpu, started, peakRss, peakPoolWaiting, utilization;

function resetMetrics() {
  queryCount = 0;
  queries.clear();
  loop.reset();
  cpu = process.cpuUsage();
  started = performance.now();
  utilization = performance.eventLoopUtilization();
  peakRss = process.memoryUsage().rss;
  peakPoolWaiting = 0;
}

async function seed() {
  const jwt = new JwtService();
  const { User } = load('users/entities/user.entity');
  const accounts = Array.from({ length: 1000 }, (_, i) => {
    const id = randomUUID();
    const role = i < 200 ? 'driver' : 'passenger';
    const payload = { sub: id, email: `load-${i}@example.invalid`, role };
    const accessToken = jwt.sign(payload, { secret: process.env.JWT_SECRET, expiresIn: '1h' });
    const refreshToken = jwt.sign(payload, { secret: process.env.JWT_REFRESH_SECRET, expiresIn: '1h' });
    return { id, role, accessToken, refreshToken, row: {
      id, email: payload.email, firstName: 'Synthetic', lastName: `Load ${i}`,
      role, isDriver: i < 200, status: 'active', isActive: true,
      accessToken: tokenFingerprint(accessToken), refreshToken: tokenFingerprint(refreshToken),
    } };
  });
  for (let i = 0; i < accounts.length; i += 100) {
    await db.getRepository(User).insert(accounts.slice(i, i + 100).map(a => a.row));
  }
  process.send({ type: 'progress', message: '1,000 synthetic accounts created' });
  const driverIds = accounts.slice(0, 200).map(a => a.id);
  const passengerIds = accounts.slice(200).map(a => a.id);
  await db.query(`INSERT INTO vehicles ("ownerId",brand,model,color,"licensePlate")
    SELECT id,'Synthetic','Load fixture','white','LOAD-' || n
    FROM unnest($1::uuid[]) WITH ORDINALITY AS u(id,n)`, [driverIds]);
  for (let offset = 0; offset < driverIds.length; offset += 20) {
    await db.query(`INSERT INTO trips ("driverId","vehicleId","departureLocation","arrivalLocation",
    "departurePoint","arrivalPoint","departureDate","totalSeats","availableSeats","pricePerSeat",status)
    SELECT u.id,v.id,'Gombe test ' || (n % 10),'Limete test ' || (n % 8),
      ST_SetSRID(ST_MakePoint(15.26 + (n%40)*0.004,-4.32-(n%30)*0.004),4326)::geography,
      ST_SetSRID(ST_MakePoint(15.32 + (n%30)*0.004,-4.44-(n%20)*0.004),4326)::geography,
      now() + CASE WHEN n<=25 THEN interval '1 day' * n ELSE interval '-1 day' * n END,
      4,4,1000 + (n%10)*250,
      CASE WHEN n<=25 THEN 'upcoming' ELSE 'completed' END::trips_status_enum
    FROM unnest($1::uuid[]) AS u(id) JOIN vehicles v ON v."ownerId"=u.id CROSS JOIN generate_series(1,50) n`, [driverIds.slice(offset, offset + 20)]);
  }
  if (process.env.LOAD_TEST_DIAGNOSTICS_ONLY !== '1') {
    for (let offset = 0; offset < 5000; offset += 250) {
      await db.query(`INSERT INTO bookings ("tripId","passengerId",status,"numberOfSeats")
      SELECT t.id,($1::uuid[])[1 + ((t.n::int * 4 + s.n) % 800)],'completed',1
      FROM (SELECT id,row_number() OVER (ORDER BY id) n FROM trips WHERE status='completed') t
      CROSS JOIN generate_series(1,4) AS s(n) WHERE t.n > $2 AND t.n <= $2 + 250`, [passengerIds, offset]);
    }
    process.send({ type: 'progress', message: '10,000 trips and 20,000 bookings created' });
    for (let i = 0; i < accounts.length; i += 20) {
      await db.query(`INSERT INTO notifications ("userId","fcmToken",title,body,status,"isRead","createdAt")
        SELECT id,'','Synthetic load notification','No push sent','sent',n%2=0,now()-n*interval '1 minute'
        FROM unnest($1::uuid[]) AS u(id) CROSS JOIN generate_series(1,50) n`,
      [accounts.slice(i, i + 20).map(a => a.id)]);
      if (i % 200 === 0) process.send({ type: 'progress', message: `${(i + 20) * 50} / 50,000 notifications created` });
    }
  }
  process.send({ type: 'progress', message: 'Synthetic fixtures complete; starting HTTP application' });
  // Use the actual migration-defined read indexes, without financial triggers.
  const runner = db.createQueryRunner();
  try {
    await runner.startTransaction();
    const { AddRideHistoryIndexes1780000036000 } = load('database/migrations/1780000036000-AddRideHistoryIndexes');
    const { IndexRatingPages1780000065000 } = load('database/migrations/1780000065000-IndexRatingPages');
    await new AddRideHistoryIndexes1780000036000().up(runner);
    await new IndexRatingPages1780000065000().up(runner);
    await runner.commitTransaction();
  } catch (error) {
    await runner.rollbackTransaction(); throw error;
  } finally { await runner.release(); }
  await db.query('ANALYZE');
  return accounts.map(({ row, ...account }) => account);
}

async function start() {
  db = new DataSource({ type: 'postgres', host: '127.0.0.1',
    port: Number(process.env.DATABASE_PORT), username: 'audit_test', database: 'postgres',
    entities: typeOrmEntities, synchronize: true, logging: ['query', 'error'],
    extra: { max: 10, connectionTimeoutMillis: 5000, statement_timeout: 30000, lock_timeout: 5000 },
    logger: {
      logQuery(query, parameters) {
        queryCount++; queries.set(query, (queries.get(query) || 0) + 1);
        if (/^(SELECT |WITH )/.test(query) && query.includes('AS "discovery_sort"') && query.includes('ST_DWithin')) {
          discoverySample = { query, parameters };
        }
      },
      logQueryError(error) { console.error('SQL error:', error); },
      logQuerySlow() {}, logSchemaBuild() {}, logMigration() {}, log() {},
    },
  });
  await db.initialize();
  const accounts = await seed();
  const { AppModule } = load('app.module');
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DataSource).useValue(db)
    // Do not run notification, settlement or maintenance jobs during this HTTP benchmark.
    .overrideProvider(ScheduleExplorer).useValue({ onModuleInit() {} })
    .compile();
  app = module.createNestApplication({ logger: ['error', 'warn'] });
  app.useLogger(app.get(require('nest-winston').WINSTON_MODULE_NEST_PROVIDER));
  const { ApiExceptionFilter } = load('common/filters/api-exception.filter');
  app.useGlobalFilters(new ApiExceptionFilter());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true,
    transform: true, transformOptions: { enableImplicitConversion: true } }));
  app.setGlobalPrefix('api/v1', { exclude: ['health', 'health/live'] });
  // Synthetic client addresses only; the listener itself cannot accept remote connections.
  app.getHttpAdapter().getInstance().set('trust proxy', 'loopback');
  await app.listen(0, '127.0.0.1');
  loop = monitorEventLoopDelay({ resolution: 20 }); loop.enable(); resetMetrics();
  timer = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    peakPoolWaiting = Math.max(peakPoolWaiting, db.driver.master.waitingCount);
  }, 100);
  process.send({ type: 'ready', port: app.getHttpServer().address().port, accounts,
    postgres: (await db.query('SELECT version() v'))[0].v,
    postgis: (await db.query('SELECT postgis_version() v'))[0].v });
}

process.on('message', async message => {
  try {
    if (message.type === 'diagnostics') {
      if (!discoverySample) throw new Error('Run the geographic search smoke test first');
      const plans = [];
      // Exact SELECT and bound parameters captured on synthetic data only.
      // No production credentials, no schema changes, no configuration persistence.
      for (const jitOff of [false, true]) {
        const plan = await db.transaction(async manager => {
          await manager.query('SET TRANSACTION READ ONLY');
          await manager.query("SET LOCAL statement_timeout = '5000ms'");
          if (jitOff) await manager.query('SET LOCAL jit = off');
          return manager.query('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' + discoverySample.query, discoverySample.parameters);
        });
        plans.push({ jitOff, plan: plan[0]['QUERY PLAN'] });
      }
      process.send({ type: 'diagnostics', id: message.id, diagnostics: { sql: discoverySample.query, plans } });
    }
    if (message.type === 'reset') { resetMetrics(); process.send({ type: 'reset', id: message.id }); }
    if (message.type === 'metrics') {
      const used = process.cpuUsage(cpu), elapsed = performance.now() - started;
      process.send({ type: 'metrics', id: message.id, metrics: {
        elapsedMs: elapsed, cpuOneCorePercent: (used.user + used.system) / (elapsed * 10),
        peakRssMb: peakRss / 1048576, eventLoopUtilization: performance.eventLoopUtilization(utilization).utilization,
        eventLoopP95Ms: loop.percentile(95) / 1e6, eventLoopMaxMs: loop.max / 1e6,
        peakPoolWaiting, queryCount, blockedExternalConnections: guard.count(),
        topQueries: [...queries].sort((a, b) => b[1] - a[1]).slice(0, 10)
          .map(([sql, count]) => ({ sql, count })),
      } });
    }
    if (message.type === 'stop') await stop();
  } catch (error) { console.error(error); process.exitCode = 1; await stop(); }
});
async function stop() {
  if (closing) return; closing = true; clearInterval(timer); loop?.disable();
  const deadline = setTimeout(() => process.exit(1), 10000); deadline.unref();
  try { if (app) await app.close(); else if (db?.isInitialized) await db.destroy(); }
  finally { process.exit(process.exitCode || 0); }
}
process.on('disconnect', stop);
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
start().catch(async error => { console.error(error); process.exitCode = 1; await stop(); });
