'use strict';

// Focused service/PostgreSQL benchmark. No target URL, application DB or .env option.
// node test/load/dispatch.cjs [--quick]; optional LOAD_TEST_PG_BIN selects binaries only.
const { join, resolve, sep } = require('node:path');
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir, cpus, totalmem } = require('node:os');
const { randomUUID } = require('node:crypto');
const { performance, monitorEventLoopDelay } = require('node:perf_hooks');
const { minimalEnvironment, restrictConnections } = require('./isolation.cjs');
const root = resolve(__dirname, '../..');
const bin = process.env.LOAD_TEST_PG_BIN || (process.platform === 'win32' ? 'C:/Program Files/PostgreSQL/18/bin' : '');
if (!bin) throw new Error('LOAD_TEST_PG_BIN is required (binaries, never a DB URL)');
const quick = process.argv.includes('--quick');
const scratch = mkdtempSync(join(tmpdir(), 'zwanga-dispatch-load-'));
const output = join(root, 'tmp', `dispatch-load-${new Date().toISOString().replace(/[:.]/g, '-')}`);
mkdirSync(output, { recursive: true });
const environment = minimalEnvironment({ NODE_ENV: 'test', TZ: 'UTC' });
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, environment);
process.chdir(scratch);
require('ts-node').register({ project: join(root, 'tsconfig.json'), transpileOnly: true });
require('reflect-metadata');
const load = path => require(join(root, 'src', path));
const { IsolatedPostgres } = require('../isolated-postgres.ts');
const { Logger } = require('@nestjs/common');
const { ConfigService } = require('@nestjs/config');
const serviceMessages = [];
Logger.overrideLogger({log(){},debug(){},verbose(){},
  warn(message){ if(serviceMessages.length<100) serviceMessages.push({level:'warn',message:String(message)}); },
  error(message){ if(serviceMessages.length<100) serviceMessages.push({level:'error',message:String(message)}); },
});
const cluster = new IsolatedPostgres(bin);
const report = {
  startedAt: new Date().toISOString(), mode: quick ? 'quick' : 'standard',
  scope: 'Real dispatch/notification services and isolated PostgreSQL/PostGIS; synthetic users and transport',
  exclusions: ['HTTP/JWT/throttling', 'real FCM/APNs delivery', 'real Socket.IO/Redis network', 'AWS/ALB/TLS', 'multi-host failover', 'long soak'],
  host: { node: process.version, logicalCpus: cpus().length, memoryGiB: Math.round(totalmem() / 2 ** 30) },
  stages: [], checks: {}, cleanup: {}, serviceMessages,
};
let db, guard, drivers, passenger, notifications, dispatchers, candidateQuery, queries = 0, aborted = false;
const queryTimings = new Map();
process.once('SIGINT', () => { aborted = true; });
process.once('SIGTERM', () => { aborted = true; });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const assert = (value, message) => { if (!value) throw new Error(message); };
const config = new ConfigService({ DRIVER_DISPATCH_ENABLED: 'true' });
const noPush = { dispatchTransactionalNotifications: async () => {}, dispatchUrgentNotifications: async () => {} };
const quantile = (values, q) => values.length ? [...values].sort((a,b) => a-b)[Math.min(values.length-1, Math.floor(values.length*q))] : 0;
const round = number => Math.round(number * 100) / 100;
async function parallel(count, concurrency, work) {
  let next = 0;
  const times = [], errors = [];
  await Promise.all(Array.from({ length: Math.min(count, concurrency) }, async () => {
    while (next < count && !aborted) {
      const i = next++, started = performance.now();
      try { await work(i); } catch (e) { errors.push(e.message); }
      times.push(performance.now()-started);
    }
  }));
  return { operations: times.length, errors, p50Ms: round(quantile(times,.5)), p95Ms: round(quantile(times,.95)), p99Ms: round(quantile(times,.99)) };
}
async function measure(name, work) {
  queries = 0;
  const loop = monitorEventLoopDelay({ resolution: 10 }); loop.enable();
  const cpu = process.cpuUsage(), start = performance.now();
  let peakPoolWaiting = 0, peakRss = process.memoryUsage().rss;
  const timer = setInterval(() => {
    peakPoolWaiting = Math.max(peakPoolWaiting, db.driver.master.waitingCount);
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }, 10);
  try {
    const result = await work(), elapsedMs = performance.now() - start, used = process.cpuUsage(cpu);
    const stage = { name, ...result, elapsedMs: round(elapsedMs), sqlQueries: queries,
      throughputPerSecond: result.operations ? round(result.operations * 1000 / elapsedMs) : undefined,
      cpuMs: round((used.user+used.system)/1000), eventLoopP99Ms: round(loop.percentile(99)/1e6),
      peakRssMiB: round(peakRss/2**20), peakPoolWaiting };
    report.stages.push(stage); console.log(JSON.stringify(stage));
  } finally { clearInterval(timer); loop.disable(); }
}
async function reset() {
  await db.query('TRUNCATE trip_requests, notifications, nearby_driver_ring_state CASCADE');
}
async function requests(count, patch = {}) {
  const { TripRequest } = load('trip-requests/entities/trip-request.entity');
  const rows = Array.from({ length: count }, () => ({ id: randomUUID(), passengerId: passenger,
    departureLocation: 'Synthetic departure', arrivalLocation: 'Synthetic arrival', immediateDispatch: true,
    departurePoint: { type: 'Point', coordinates: [15.31,-4.3] }, arrivalPoint: { type:'Point', coordinates:[15.32,-4.3] },
    departureDateMin: new Date(Date.now()+1000), departureDateMax: new Date(Date.now()+3600000),
    numberOfSeats: 1, maxPricePerSeat: 1000, vehicleType: 'car', ...patch }));
  await db.getRepository(TripRequest).insert(rows);
  return rows;
}
async function dispatchWork(count, replicas, cadenceMs = 0) {
  let covered = 0, cycles = 0;
  const start = performance.now();
  while (covered < count && performance.now()-start < 90000 && !aborted) {
    await Promise.all(dispatchers.slice(0,replicas).map(service => service.tick())); cycles++;
    covered = Number((await db.query('SELECT count(DISTINCT "requestId") AS n FROM trip_request_dispatch_offers'))[0].n);
    if (covered < count) {
      // Nest cron runs on fixed boundaries, not five seconds AFTER a batch.
      // Skip boundaries occupied by an unfinished tick, as the process guard does.
      const elapsed = performance.now()-start;
      await pause(cadenceMs ? Math.max(1, (Math.floor(elapsed/cadenceMs)+1)*cadenceMs-elapsed) : 1);
    }
  }
  const rows = await db.query(`SELECT extract(epoch FROM (min(o."createdAt") - r."createdAt"))*1000 AS ms
    FROM trip_requests r JOIN trip_request_dispatch_offers o ON o."requestId" = r.id GROUP BY r.id`);
  const times = rows.map(row => Number(row.ms));
  const duplicate = await db.query(`SELECT "requestId" FROM trip_request_dispatch_offers
    WHERE status='pending' GROUP BY "requestId" HAVING count(*)>1`);
  assert(covered === count, `Dispatch timeout: ${covered}/${count}`);
  assert(!duplicate.length, 'Duplicate live invitation');
  return { operations: covered, cycles, replicas, cadenceMs, initialCronWaitMs:0,
    firstOfferP50Ms: round(quantile(times,.5)), firstOfferP95Ms: round(quantile(times,.95)), firstOfferMaxMs: round(Math.max(...times)) };
}
async function main() {
  db = await cluster.start();
  guard = restrictConnections([db.options.port]);
  const { typeOrmEntities } = load('database/entities');
  db.setOptions({ entities: typeOrmEntities }); await db.buildMetadatas();
  await db.query('CREATE EXTENSION postgis; CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
  await db.synchronize();
  await db.query('ALTER TABLE trip_requests DROP COLUMN "immediateDispatch"');
  const runner = db.createQueryRunner();
  try {
    for (const [file, name] of [
      ['1780000048000-AddDriverDispatch','AddDriverDispatch1780000048000'],
      ['1780000074000-BroadcastDriverRequests','BroadcastDriverRequests1780000074000'],
      ['1780000076000-RetainDriverLastLocation','RetainDriverLastLocation1780000076000'],
      ['1780000087000-NearbyRequestRingingCooldown','NearbyRequestRingingCooldown1780000087000'],
      ['1780000088000-DispatchDeliveryResilience','DispatchDeliveryResilience1780000088000'],
    ]) await new (load(`database/migrations/${file}`)[name])().up(runner);
  } finally { await runner.release(); }
  // synchronize() does not recreate this existing migration-52 index. Include
  // it in the fixture without replaying financial triggers unrelated to dispatch.
  await db.query('CREATE INDEX "IDX_kyc_welcome_latest" ON kyc_documents ("userId", "createdAt" DESC, id DESC)');
  report.fixture = 'Entity schema + dispatch migrations + existing migration-52 latest-KYC index; no financial triggers';
  report.database = { ...(await db.query('SELECT version() AS version'))[0], poolMax:8 };
  const { User } = load('users/entities/user.entity');
  const { Vehicle } = load('vehicles/entities/vehicle.entity');
  const { KycDocument } = load('users/entities/kyc-document.entity');
  const { TripRequest } = load('trip-requests/entities/trip-request.entity');
  const { Notification } = load('notifications/entities/notification.entity');
  const { DriverDispatchService } = load('trip-requests/dispatch/dispatch.service');
  const { NotificationService } = load('notifications/notifications.service');
  const { claimRideRealtimeNotifications } = load('notifications/ride-realtime-delivery');
  drivers = Array.from({length:quick ? 100 : 1000}, (_, i) => ({id:randomUUID(),vehicleId:randomUUID(), index:i}));
  passenger = randomUUID();
  await db.getRepository(User).insert([{id:passenger,firstName:'Synthetic',lastName:'Passenger'},
    ...drivers.map(d=>({id:d.id,firstName:'Synthetic',lastName:`Driver${d.index}`,role:'driver',isDriver:true,status:'active',isActive:true,fcmToken:`synthetic-${d.id}`}))]);
  await db.getRepository(Vehicle).insert(drivers.map(d=>({id:d.vehicleId,ownerId:d.id,brand:'Synthetic',model:'Load',color:'Test',licensePlate:d.id,type:'car',isActive:true})));
  await db.getRepository(KycDocument).insert(drivers.map(d=>({userId:d.id,status:'approved'})));
  await db.query(`INSERT INTO driver_dispatch_presence ("driverId","vehicleId",seats,position,"expiresAt","leaseId","discoveryEnabled")
    SELECT "ownerId",id,4,ST_SetSRID(ST_MakePoint(15.31 + random()*0.01,-4.3 + random()*0.01),4326)::geography,
      now()+interval '1 day',id,true FROM vehicles`);
  await db.query('ANALYZE');
  report.population = {drivers:drivers.length, activeVehicles:drivers.length, approvedKyc:drivers.length};
  const createRunner = db.createQueryRunner.bind(db);
  db.createQueryRunner = (...args) => {
    const qr = createRunner(...args), query = qr.query.bind(qr);
    qr.query = async (...params) => {
      queries++;
      const sql = String(params[0]), started = performance.now();
      if (!candidateQuery && sql.includes('JOIN LATERAL (SELECT v.*')) candidateQuery = params.slice(0,2);
      try { return await query(...params); }
      finally {
        const key = sql.replace(/\s+/g,' ').trim();
        const previous = queryTimings.get(key) || {count:0,totalMs:0,maxMs:0};
        const elapsed = performance.now()-started;
        previous.count++; previous.totalMs += elapsed; previous.maxMs = Math.max(previous.maxMs,elapsed);
        queryTimings.set(key,previous);
      }
    };
    return qr;
  };
  dispatchers = Array.from({length:3},()=>new DriverDispatchService(db,config,noPush));
  await requests(5); await dispatchWork(5,1); // Warm-up excluded.
  if (candidateQuery) report.candidatePlan = (await db.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${candidateQuery[0]}`,candidateQuery[1]))[0]['QUERY PLAN'];
  await reset();
  if (process.argv.includes('--diagnose')) return;
  for (const replicas of [1,3]) {
    const n = quick ? 25 : 200; await requests(n);
    await measure(`allocation_saturated_${replicas}_worker_process_simulations`,()=>dispatchWork(n,replicas)); await reset();
  }
  const n = quick ? 30 : 100; await requests(n);
  await measure('allocation_real_5s_cadence',()=>dispatchWork(n,1,5000)); await reset();
  for (const concurrency of (quick ? [5] : [1,10,30])) {
    await measure(`gps_${concurrency}_concurrent`,()=>parallel(quick ? 30 : 300,concurrency, i=>dispatchers[0].recordPosition(drivers[i%drivers.length].id,
      {latitude:-4.3,longitude:15.31,recordedAt:new Date().toISOString()})));
  }
  if (!quick) {
    await requests(100);
    await measure('mixed_dispatch_and_gps', async () => {
      const [allocation, gps] = await Promise.all([dispatchWork(100,3), parallel(300,10, i=>dispatchers[0].recordPosition(drivers[i%drivers.length].id,
        {latitude:-4.3,longitude:15.31,recordedAt:new Date().toISOString()}))]);
      assert(!gps.errors.length, 'Mixed GPS failed');
      return {operations:allocation.operations+gps.operations, allocation, gps};
    });
    await reset();
  }
  await reset(); await requests(30,{departurePoint:null}); const [valid] = await requests(1);
  await dispatchers[0].tick();
  assert((await db.query('SELECT * FROM trip_request_dispatch_offers WHERE "requestId"=$1',[valid.id])).length===1,'Invalid requests starved queue');
  report.checks.invalidRequestsDoNotStarve = true;
  await reset(); const [rollback] = await requests(1);
  try {
    await db.transaction(async manager => {
      const r = await manager.getRepository(TripRequest).findOne({where:{id:rollback.id},lock:{mode:'pessimistic_write'}});
      await dispatchers[0].allocateNext(manager,r);
      await manager.query('SELECT 1 / 0'); // Real PostgreSQL failure before commit.
    });
  } catch (error) { assert(error.code==='22012','Unexpected fault simulation error'); }
  assert(Number((await db.query('SELECT count(*) AS n FROM trip_request_dispatch_offers'))[0].n)===0,'Rollback leaked invitation');
  assert(await db.getRepository(Notification).count()===0,'Rollback leaked outbox');
  await dispatchers[0].tick();
  report.checks.rollbackAtomicAndRecovery = (await db.query('SELECT * FROM trip_request_dispatch_offers')).length===1;
  const [offer] = await db.query('SELECT * FROM trip_request_dispatch_offers');
  await measure('concurrent_acceptance_retries',()=>parallel(12,12,()=>dispatchers[0].respond(offer.driverId,offer.id,'accept')));
  assert(Number((await db.query('SELECT count(*) AS n FROM driver_offers'))[0].n)===1,'Duplicate accepted offer');
  report.checks.singleAcceptance = true;
  await reset(); await requests(quick ? 3 : 20); await dispatchWork(quick ? 3 : 20,1);
  const refused = await db.query("SELECT * FROM trip_request_dispatch_offers WHERE status='pending'");
  await measure('decline_to_next_driver',()=>parallel(refused.length,quick ? 1 : 5, async i=>{
    const previous=refused[i];
    await dispatchers[0].respond(previous.driverId,previous.id,'decline');
    const next=await db.query(`SELECT * FROM trip_request_dispatch_offers WHERE "requestId"=$1 AND status='pending'`,[previous.requestId]);
    assert(next.length===1 && next[0].driverId!==previous.driverId,'Refusal did not reserve the next driver');
  }));
  report.checks.refusalImmediatelyReservesSuccessor = true;
  await reset(); await requests(quick ? 10 : 50); await dispatchWork(quick ? 10 : 50,1);
  const deliveries = new Set(); let duplicateEvents = 0;
  const realtime = {isBound:()=>true,publish:(_user,event)=>{ if(deliveries.has(event.eventId))duplicateEvents++; deliveries.add(event.eventId); return true; }};
  notifications = new NotificationService(config,db.getRepository(Notification),db.getRepository(User),db.getRepository(TripRequest),realtime);
  // No onModuleInit: no Firebase credentials. Occupied push capacity simulates hung provider calls.
  notifications.urgentWorkers = 5;
  notifications.sendFirebaseNotification = async()=>{throw new Error('Synthetic provider outage');};
  notifications.sendExpoPushNotification = async()=>{throw new Error('Synthetic provider outage');};
  const claimed = await claimRideRealtimeNotifications(db.manager); // Worker dies after claiming, before sending.
  assert(claimed.length===(quick?10:50),'Unexpected realtime claim count');
  await db.query(`UPDATE ride_realtime_deliveries SET "attemptedAt"=now()-interval '6 seconds'`);
  await measure('realtime_during_push_outage_and_crashed_worker_recovery',async()=>{
    await notifications.dispatchRealtimeNotifications();
    return {operations:deliveries.size,duplicateEvents};
  });
  assert(deliveries.size===claimed.length && duplicateEvents===0,'Realtime outage recovery failed');
  report.checks.realtimeIndependentAndRecovered = true;
  const [event] = await db.query('SELECT * FROM nearby_driver_ring_events LIMIT 1');
  const { acknowledgeNearbyRequest, reconcileNearbyRequestCooldowns } = load('notifications/nearby-request-cooldown');
  assert((await acknowledgeNearbyRequest(db.manager,event.driverId,event.notificationId)).received,'Device receipt failed');
  await db.query(`UPDATE nearby_driver_ring_events SET "responseDeadline"=now()-interval '1 second',
    "receivedAt"=CASE WHEN "receivedAt" IS NOT NULL THEN now()-interval '20 seconds' ELSE NULL END`);
  await reconcileNearbyRequestCooldowns(db.manager);
  const states = await db.query('SELECT * FROM nearby_driver_ring_state');
  assert(states.filter(s=>s.missedCount===1).length===1 && states.every(s=>!s.mutedUntil),'False offline penalties');
  report.checks.onlyConfirmedDeviceReceiptCounts = true;
  if (!quick) {
    await reset(); await requests(10,{immediateDispatch:false,departureDateMin:new Date(Date.now()+86400000),departureDateMax:new Date(Date.now()+90000000)});
    await dispatchers[0].tick();
    const expected=await db.getRepository(Notification).count();
    assert(expected===500,'Expected ten broadcasts with fifty recipients each');
    deliveries.clear(); duplicateEvents=0;
    await measure('scheduled_fanout_500_notifications_2s_cadence',async()=>{
      const started=performance.now();
      for(let batch=0;batch<5;batch++) {
        await notifications.dispatchRealtimeNotifications();
        if(batch<4) {
          const elapsed=performance.now()-started;
          await pause(Math.max(1,(Math.floor(elapsed/2000)+1)*2000-elapsed));
        }
      }
      return {operations:deliveries.size,expected,duplicateEvents,cadenceMs:2000};
    });
    assert(deliveries.size===expected && duplicateEvents===0,'Fanout exceeded its deadline or duplicated recipients');
    report.checks.fanout500WithinOriginalDeadline=true;
  }
  assert(!aborted,'Benchmark interrupted');
  assert(report.stages.every(s=>!s.errors?.length),'Benchmark operations failed');
  assert(Object.values(report.checks).every(Boolean),'Resilience assertion failed');
}
main().catch(error=>{
  report.error={message:error.message,code:error.code}; process.exitCode=1; console.error(error.message);
}).finally(async()=>{
  report.finishedAt=new Date().toISOString(); report.blockedExternalConnections=guard?.count()??0;
  report.slowestQueries = [...queryTimings].sort((a,b)=>b[1].totalMs-a[1].totalMs).slice(0,10)
    .map(([sql,timing])=>({sql,...timing}));
  try { await cluster.stop(); report.cleanup.postgresStopped=true; }
  catch(error){report.cleanup.error=error.message;process.exitCode=1;}
  guard?.restore(); process.chdir(root);
  if(resolve(scratch).startsWith(resolve(tmpdir())+sep+'zwanga-dispatch-load-')) rmSync(scratch,{recursive:true,force:true});
  writeFileSync(join(output,'report.json'),JSON.stringify(report,null,2));
  console.log(`Report: ${join(output,'report.json')}`);
});
