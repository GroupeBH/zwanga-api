'use strict';

const { join, resolve } = require('node:path');
const { existsSync } = require('node:fs');
const { performance, monitorEventLoopDelay } = require('node:perf_hooks');
const { restrictConnections } = require('../isolation.cjs');
const { registeredSocketReady } = require('./readiness.cjs');
const { WORKERS } = require('./workers.cjs');
require('./container-child.cjs').installStdioBridge();
if (!process.send || process.env.ZWANGA_JOURNEY_CHILD !== '1' ||
    existsSync(join(process.cwd(), '.env')) || existsSync(resolve('..', '.env'))) throw new Error('Use the isolated journey runner');
const guard = restrictConnections([process.env.DATABASE_PORT, process.env.REDIS_PORT]);
const load = name => require(join(process.env.LOAD_TEST_BUILD_DIR, name));
const bootstrap = require('./bootstrap-diagnostics.cjs').bootstrapDiagnostics();
bootstrap('load_dependencies');
require('reflect-metadata');
const { DataSource } = require('typeorm');
const { Test } = require('@nestjs/testing');
const { ConfigService } = require('@nestjs/config');
const { ValidationPipe } = require('@nestjs/common');
const { ScheduleExplorer } = require('@nestjs/schedule/dist/schedule.explorer');
const { createClient } = require('redis');
const { createResilientRedisAdapter } = load('common/resilient-redis.adapter');
let app, db, pub, sub, closing = false, pushes = 0, workerErrors = 0, redisTransportErrors = 0;
let sqlQueries = 0, sqlErrors = 0, slowQueries = 0, slowestQueryMs = 0;
let progressPaused = false;
let sqlProfiler;
let poolSnapshot, runtime;
const trackingDiagnostics = process.env.LOAD_TEST_PROFILE_TRACKING === '1'
  ? new (require('./tracking-diagnostics.cjs').TrackingDiagnostics)() : null;
const socketWrites = trackingDiagnostics ? require('./socket-write-diagnostics.cjs').observeSocketWrites(
  require('node:net').Socket.prototype,
  { postgresPort: Number(process.env.DATABASE_PORT), redisPort: Number(process.env.REDIS_PORT) }) : null;
const cpuDiagnostics = process.env.LOAD_TEST_PROFILE_CPU === '1'
  ? new (require('./cpu-diagnostics.cjs').CpuDiagnostics)() : null;
const timers = [], work = new Set();
const loop = monitorEventLoopDelay({ resolution: 20 });
const cpuStart = process.cpuUsage(), timeStart = performance.now();
let peakRss = 0, peakPoolWaiting = 0;
const replicaApplication = require('./replica-identity.cjs').replicaApplicationName(Number(process.env.LOAD_TEST_REPLICA_INDEX));
const notify = message => { if (process.connected) process.send(message); };
async function start() {
  bootstrap('initialize_database');
  db = new DataSource({ type: 'postgres', host: '127.0.0.1', port: Number(process.env.DATABASE_PORT),
    username: 'audit_test', database: 'postgres', entities: load('database/entities').typeOrmEntities,
    synchronize: false, extra: { max: 10, application_name: replicaApplication,
      connectionTimeoutMillis: 5000, statement_timeout: 10000, lock_timeout: 3000 },
    logging: ['query', 'error'], maxQueryExecutionTime: 250,
    logger: { logQuery() { sqlQueries++; }, logQueryError(error) { sqlErrors++; console.error('SQL failed:', String(error).slice(0, 200)); },
      logQuerySlow(ms) { slowQueries++; slowestQueryMs = Math.max(slowestQueryMs, ms); },
      logSchemaBuild() {}, logMigration() {}, log() {} } });
  await db.initialize();
  const timeAlignment = await require('./time-alignment.cjs').verifyTimeAlignment(db);
  poolSnapshot = require('./pool-diagnostics.cjs').observePool(db.driver.master,
    process.env.LOAD_TEST_PROFILE_SQL === '1' ? {
      capturePressure: () => sqlProfiler ? { ...sqlProfiler.occupancy.activeSnapshot(),
        acquisitions: sqlProfiler.acquisitions.snapshot() } : { unavailable: true },
    } : {});
  if (process.env.LOAD_TEST_PROFILE_SQL === '1') {
    sqlProfiler = new (require('./sql-profiler.cjs').SqlProfiler)(require('./profiled-tables.cjs').profiledTables(db));
    sqlProfiler.install(db);
  }
  bootstrap('compile_nest');
  trackingDiagnostics?.installSql(db, load);
  if (trackingDiagnostics) {
    const dto = load('tracking/dto/tracking-socket.dto');
    trackingDiagnostics.installValidation(ValidationPipe.prototype, dto.DriverLocationSocketDto, dto.PassengerLocationSocketDto);
  }
  const module = await Test.createTestingModule({ imports: [load('app.module').AppModule] })
    .overrideProvider(DataSource).useValue(db)
    .overrideProvider(ScheduleExplorer).useValue({ onModuleInit() {} }).compile();
  app = module.createNestApplication({ logger: ['warn', 'error'] });
  app.useLogger(app.get(require('nest-winston').WINSTON_MODULE_NEST_PROVIDER));
  app.useGlobalFilters(new (load('common/filters/api-exception.filter').ApiExceptionFilter)());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true,
    transform: true, transformOptions: { enableImplicitConversion: true } }));
  app.setGlobalPrefix('api/v1', { exclude: ['health', 'health/live'] });
  // Same bounded offline queue and reconnection policy as the production adapter.
  bootstrap('connect_redis');
  pub = createClient(load('common/utils/redis-options').buildRedisClientOptions(app.get(ConfigService)));
  sub = pub.duplicate();
  for (const client of [pub, sub]) client.on('error', () => { redisTransportErrors++; });
  await Promise.all([pub.connect(), sub.connect()]);
  trackingDiagnostics?.installPublisher(pub);
  const { ConfiguredIoAdapter } = load('common/configured-io.adapter');
  class ClusterAdapter extends ConfiguredIoAdapter {
    createIOServer(port, options) {
      const server = super.createIOServer(port, options);
      server.adapter(createResilientRedisAdapter(pub, sub, () => { redisTransportErrors++; })); return server;
    }
  }
  app.useWebSocketAdapter(new ClusterAdapter(app, app.get(ConfigService)));
  const notifications = app.get(load('notifications/notifications.service').NotificationService);
  trackingDiagnostics?.installProviders(app, load);
  if (sqlProfiler) {
    // Provider methods only: do not replace decorated HTTP/WS handlers or guards.
    for (const worker of WORKERS) sqlProfiler.wrapMethod(app.get(load(worker.path)[worker.service]),
      worker.method, `worker:${worker.service}.${worker.method}`);
    sqlProfiler.wrapMethod(app.get(load('tracking/ride-progress.worker').RideProgressWorker), 'process', 'worker:RideProgressWorker.process');
    for (const [path, service, method] of [
      ['users/users.service', 'UsersService', 'findAuthIdentity'],
      ['common/services/ws-session.service', 'WsSessionService', 'connect'],
      ['common/services/ws-session.service', 'WsSessionService', 'validateSessions'],
      ['tracking/tracking-state.service', 'TrackingStateService', 'read'],
      ['trips/trips.service', 'TripsService', 'ensureUserCanTrackTrip'],
      ['trips/trips.service', 'TripsService', 'updateDriverLocation'],
      ['bookings/bookings.service', 'BookingsService', 'updatePassengerLocation'],
      ['bookings/bookings.service', 'BookingsService', 'evaluateAutomaticRideProgressForTrip'],
      ['bookings/bookings.service', 'BookingsService', 'tryConfirmAutomaticPickup'],
      ['bookings/bookings.service', 'BookingsService', 'tryConfirmAutomaticDropoff'],
      ['bookings/bookings.service', 'BookingsService', 'tryConfirmAutomaticNoShow'],
      ['bookings/bookings.service', 'BookingsService', 'tryCompleteTripAtDestination'],
      ['bookings/bookings.service', 'BookingsService', 'touchTripInteraction'],
      ['common/services/location-history.service', 'LocationHistoryService', 'recordDriverLocation'],
      ['common/services/location-history.service', 'LocationHistoryService', 'recordPassengerLocation'],
      ['common/services/location-history.service', 'LocationHistoryService', 'withRideSnapshot'],
      ['notifications/notifications.service', 'NotificationService', 'prepareSavedNotification'],
      ['notifications/notifications.service', 'NotificationService', 'publishRealtimeInvitation'],
      ['trip-requests/dispatch/dispatch.service', 'DriverDispatchService', 'acknowledgeNotification'],
      ['trip-requests/dispatch/dispatch.service', 'DriverDispatchService', 'respond'],
      ['trip-requests/trip-requests.service', 'TripRequestsService', 'create'],
      ['trip-requests/trip-requests.service', 'TripRequestsService', 'cancel'],
      ['trip-requests/trip-requests.service', 'TripRequestsService', 'acceptTripRequest'],
      ['trip-requests/dispatch/dispatch.service', 'DriverDispatchService', 'recordPosition'],
      ['trip-requests/dispatch/dispatch.service', 'DriverDispatchService', 'setPresence'],
      ['trip-requests/dispatch/dispatch.service', 'DriverDispatchService', 'status'],
      ['trip-requests/dispatch/dispatch.service', 'DriverDispatchService', 'isBusy'],
      ['trip-requests/dispatch/sequential-dispatch.service', 'SequentialDispatchService', 'driverAvailable'],
      ['trip-requests/dispatch/driver-availability-wakeups', 'DriverAvailabilityWakeups', 'driversAvailable'],
      ['trip-requests/dispatch/sequential-dispatch.service', 'SequentialDispatchService', 'advance'],
    ]) sqlProfiler.wrapMethod(app.get(load(path)[service]), method, `service:${method}`);
  }
  // Keep database outbox, retries, recipients and realtime. Only paid transport is a sink.
  notifications.sendFirebaseNotification = async () => { pushes++; return `synthetic-${pushes}`; };
  bootstrap('listen');
  await app.listen(Number(process.env.LOAD_TEST_HTTP_PORT) || 0, '127.0.0.1');
  if (trackingDiagnostics) trackingDiagnostics.installBroadcast(app.get(load('tracking/tracking.gateway').TrackingGateway).server.adapter);
  function schedule(ms, fn) {
    let busy = false;
    timers.push(setInterval(() => {
      if (closing || busy) return;
      busy = true;
      const pending = Promise.resolve().then(fn).catch(() => { workerErrors++; })
        .finally(() => { busy = false; work.delete(pending); });
      work.add(pending);
    }, ms));
  }
  for (const worker of WORKERS) {
    const instance = app.get(load(worker.path)[worker.service]);
    schedule(worker.intervalMs, () => progressPaused && worker.service === 'RideProgressWorker' ? undefined : instance[worker.method]());
  }
  loop.enable();
  runtime = require('./generator-runtime.cjs').observeGenerator(() => 'steady');
  timers.push(setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss / 2 ** 20);
    peakPoolWaiting = Math.max(peakPoolWaiting, db.driver.master.waitingCount);
  }, 100));
  bootstrap('ready');
  notify({ type: 'ready', port: app.getHttpServer().address().port, workers: WORKERS, timeAlignment });
}
process.on('message', async message => {
  if (message.type === 'cpu-profile' && cpuDiagnostics && ['start', 'stop'].includes(message.action)) {
    try {
      await cpuDiagnostics[message.action]();
      notify({ id: message.id, profile: cpuDiagnostics.snapshot() });
    } catch { notify({ id: message.id, profile: { state: 'failed' } }); }
  }
  if (message.type === 'pause-progress' && process.env.LOAD_TEST_FAULTS_ENABLED === '1' && typeof message.paused === 'boolean') {
    progressPaused = message.paused;
    await Promise.allSettled([...work]);
    notify({ id: message.id, paused: progressPaused });
  }
  if (message.type === 'socket-observed') {
    const gateway = message.namespace === '/tracking'
      ? app.get(load('tracking/tracking.gateway').TrackingGateway) : app.get(load('chat/chat.gateway').ChatGateway);
    const socket = gateway.server.sockets.get(message.socketId);
    const sessions = app.get(load('common/services/ws-session.service').WsSessionService);
    // authenticateSocket sets userId before the DB/token/quota checks finish.
    // Observe completed registration, not that early JWT-only marker. Never register on its behalf.
    const room = message.room ?? (message.namespace === '/chat' && socket ? `user:${socket.data.userId}` : undefined);
    notify({ id: message.id, ready: registeredSocketReady(socket, sessions.sessions, room) });
  }
  if (message.type === 'stop') {
    if (closing) return;
    closing = true; timers.forEach(clearInterval); loop.disable();
    runtime?.stop(); socketWrites?.stop(); await cpuDiagnostics?.stop().catch(() => {});
    await Promise.allSettled([...work]);
    await app?.close();
    await Promise.allSettled([pub?.isOpen && pub.quit(), sub?.isOpen && sub.quit()]);
    if (db?.isInitialized) await db.destroy();
    process.exit(0);
  }
  if (message.type === 'metrics') {
    const cpu = process.cpuUsage(cpuStart);
    const pool = poolSnapshot();
    peakPoolWaiting = Math.max(peakPoolWaiting, pool.peakWaiting);
    notify({ type: 'metrics', id: message.id, metrics: {
      replica: require('./replica-identity.cjs').replicaFromApplicationName(replicaApplication),
      responseAdmission: load('trip-requests/dispatch/dispatch-response-admission').dispatchResponseAdmission(db).snapshot(),
      receiptAdmission: load('trip-requests/dispatch/receipt-admission').receiptAdmission(db).snapshot(),
      ...(sqlProfiler ? { pendingAcquisitions: sqlProfiler.acquisitions.snapshot() } : {}),
      sampledAt: new Date().toISOString(), rssMiB: process.memoryUsage().rss / 2 ** 20,
      pool,
      sqlAdmission: load('database/background-sql-budget').backgroundSqlBudget(db).snapshot(),
      dispatch: app.get(load('trip-requests/dispatch/sequential-dispatch.service').SequentialDispatchService).diagnosticSnapshot(),
      websocketWork: app.get(load('common/services/ws-session.service').WsSessionService).workloadSnapshot(),
      runtime: runtime.snapshot(),
      ...(trackingDiagnostics ? { trackingPhases: trackingDiagnostics.snapshot() } : {}),
      eventLoopMaxMs: loop.max / 1e6,
      peakRssMiB: peakRss, peakPoolWaiting, eventLoopP99Ms: loop.percentile(99) / 1e6,
      cpuMs: (cpu.user + cpu.system) / 1000, elapsedMs: performance.now() - timeStart,
      ...(socketWrites ? { socketWrites: socketWrites.snapshot() } : {}),
      blockedExternalConnections: guard.count(), workerErrors, syntheticPushes: pushes,
      sqlQueries, sqlErrors, slowQueriesOver250ms: slowQueries, slowestQueryMs,
      redisTransportErrors, redisReady: pub.isReady && sub.isReady,
      architecture: process.arch, node: process.version,
      ...(sqlProfiler ? { sqlProfile: sqlProfiler.snapshot() } : {}),
    } });
  }
});
start().catch(error => { console.error(error); process.exit(1); });
