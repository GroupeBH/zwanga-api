import { execFileSync } from 'node:child_process';
import { postgresTestServerOptions } from '../../../test/postgres-test-options';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { typeOrmEntities } from '../../database/entities';
import { AddDriverDispatch1780000048000 } from '../../database/migrations/1780000048000-AddDriverDispatch';
import { BroadcastDriverRequests1780000074000 } from '../../database/migrations/1780000074000-BroadcastDriverRequests';
import { RetainDriverLastLocation1780000076000 } from '../../database/migrations/1780000076000-RetainDriverLastLocation';
import { NearbyRequestRingingCooldown1780000087000 } from '../../database/migrations/1780000087000-NearbyRequestRingingCooldown';
import { DispatchDeliveryResilience1780000088000 } from '../../database/migrations/1780000088000-DispatchDeliveryResilience';
import { enqueueStaleLocationReminders, isStaleLocationReminderDeliverable } from './stale-location-reminder';
import { IndexNearbyRequestAlerts1780000066000 } from '../../database/migrations/1780000066000-IndexNearbyRequestAlerts';
import { DriverDispatchService } from './dispatch.service';
import { User, UserRole, UserStatus } from '../../users/entities/user.entity';
import { KycDocument, KycStatus } from '../../users/entities/kyc-document.entity';
import { Vehicle, VehicleType } from '../../vehicles/entities/vehicle.entity';
import { TripRequest, TripRequestStatus } from '../entities/trip-request.entity';
import { DriverOffer } from '../entities/driver-offer.entity';
import { TripRequestsService } from '../trip-requests.service';
import { boundedInteger, dispatchOfferIsActionable } from './dispatch-policy';
import { NotificationService } from '../../notifications/notifications.service';
import { Notification } from '../../notifications/entities/notification.entity';
import { RideAlertChanges } from '../../notifications/ride-alert-changes';
import { claimRideRealtimeNotifications } from '../../notifications/ride-realtime-delivery';

describe('dispatch policy', () => {
  it.each([undefined, '60', '180', '300', '600', '900', '901'])(
    'keeps a presence window compatible with the 3-minute heartbeat (%s)', value => {
      const service = new DriverDispatchService({} as any,
        { get: () => value } as any, {} as any);
      expect(service['positionSeconds']).toBe(value === '600' ? 600 : value === '900' ? 900 : 300);
    });
  it('bounds configuration and treats the exact deadline as expired', () => {
    expect(boundedInteger(undefined, 30, 10, 120)).toBe(30);
    expect(boundedInteger('0', 30, 10, 120)).toBe(30);
    expect(boundedInteger('45', 30, 10, 120)).toBe(45);
    expect(dispatchOfferIsActionable('pending', new Date(1000), 'pending', 1000)).toBe(false);
    expect(dispatchOfferIsActionable('pending', new Date(1001), 'pending', 1000)).toBe(true);
    expect(dispatchOfferIsActionable('pending', new Date(1001), 'cancelled', 1000)).toBe(false);
  });
});

// Disposable loopback cluster ONLY. Never reads .env or accepts an application DB URL.
const pgBin = process.env.DISPATCH_TEST_POSTGRES_BIN;
(pgBin ? describe : describe.skip)('dispatch on real PostgreSQL/PostGIS', () => {
  let directory: string, started = false, source: DataSource, service: DriverDispatchService;
  let dispatchCycles: jest.SpyInstance<Promise<void>, []>;
  const notifications = { dispatchTransactionalNotifications: jest.fn().mockResolvedValue(undefined),
    dispatchUrgentNotifications: jest.fn().mockResolvedValue(undefined) };
  const waitForDispatchCycles = async () => {
    // Drain explicit concurrent cycles before destroying their fixtures.
    // respond() now commits the successor inline and no longer detaches tick().
    const results = await Promise.allSettled((dispatchCycles?.mock.results ?? [])
      .filter(result => result.type === 'return').map(result => result.value));
    dispatchCycles?.mockClear();
    const rejected = results.find(result => result.status === 'rejected');
    if (rejected?.status === 'rejected') throw rejected.reason;
  };
  const executable = (name: string) => join(pgBin!, process.platform === 'win32' ? `${name}.exe` : name);
  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'zwanga-dispatch-test-'));
    execFileSync(executable('initdb'), ['-D', directory, '-U', 'dispatch_test', '-A', 'trust', '--no-locale', '-E', 'UTF8'], { windowsHide: true, stdio: 'pipe', timeout: 30000 });
    const port = await new Promise<number>(done => {
      const server = createServer(); server.listen(0, '127.0.0.1', () => {
        const port = (server.address() as { port: number }).port;
        server.close(() => done(port));
      });
    });
    try {
      execFileSync(executable('pg_ctl'), ['-D', directory, '-l', join(directory, 'postgres.log'), '-o', postgresTestServerOptions(port), '-w', 'start'], { windowsHide: true, stdio: 'ignore', timeout: 30000 });
    } catch {
      const log = join(directory, 'postgres.log');
      throw new Error(`Disposable PostgreSQL failed to start: ${existsSync(log) ? readFileSync(log, 'utf8') : 'no server log'}`);
    }
    started = true;
    source = new DataSource({ type: 'postgres', host: '127.0.0.1', port, username: 'dispatch_test', database: 'postgres', entities: typeOrmEntities, synchronize: false });
    await source.initialize();
    await source.query('CREATE EXTENSION IF NOT EXISTS postgis');
    await source.synchronize();
    await source.query('ALTER TABLE trip_requests DROP COLUMN "immediateDispatch"');
    const runner = source.createQueryRunner();
    try {
      await new AddDriverDispatch1780000048000().up(runner);
      await new BroadcastDriverRequests1780000074000().up(runner);
      await new RetainDriverLastLocation1780000076000().up(runner);
      await new NearbyRequestRingingCooldown1780000087000().up(runner);
      await new DispatchDeliveryResilience1780000088000().up(runner);
    } finally { await runner.release(); }
    service = new DriverDispatchService(source, new ConfigService({ DRIVER_DISPATCH_ENABLED: 'true' }),
      notifications as never);
    dispatchCycles = jest.spyOn(service, 'tick');
  }, 60000);
  beforeEach(async () => {
    await waitForDispatchCycles();
    await source.query('TRUNCATE users CASCADE');
    notifications.dispatchUrgentNotifications.mockClear();
  });
  afterEach(waitForDispatchCycles);
  afterAll(async () => {
    try {
      try { await waitForDispatchCycles(); }
      finally { if (source?.isInitialized) await source.destroy(); }
    }
    finally {
      dispatchCycles?.mockRestore();
      if (started || (directory && existsSync(join(directory, 'postmaster.pid'))))
        execFileSync(executable('pg_ctl'), ['-D', directory, '-m', 'fast', '-w', 'stop'], { windowsHide: true, stdio: 'ignore', timeout: 30000 });
      if (directory && resolve(directory).startsWith(resolve(tmpdir()) + sep) && directory.includes('zwanga-dispatch-test-'))
        rmSync(directory, { recursive: true, force: true });
    }
  });
  const passenger = () => source.getRepository(User).save({ firstName: 'Test', lastName: 'Passager' });
  const driver = async (longitude = 15.31, type = VehicleType.CAR, seats = 4) => {
    const user = await source.getRepository(User).save({ firstName: 'Test', lastName: 'Conducteur',
      role: UserRole.DRIVER, status: UserStatus.ACTIVE, isDriver: true, fcmToken: `fixture-${randomUUID()}` });
    await source.getRepository(KycDocument).save({ userId: user.id, status: KycStatus.APPROVED });
    const vehicle = await source.getRepository(Vehicle).save({ ownerId: user.id, brand: 'Test', model: 'Test', color: 'Test', licensePlate: randomUUID(), type });
    await service.registerNotifications(user.id);
    const presence = await service.setPresence(user.id, { available: true, vehicleId: vehicle.id, seats, latitude: -4.3, longitude });
    return { user, vehicle, presence };
  };
  const request = async (immediateDispatch = true, seats = 1) => {
    const user = await passenger();
    return source.getRepository(TripRequest).save({ passengerId: user.id, immediateDispatch,
      departureLocation: 'Départ de test', arrivalLocation: 'Arrivée de test',
      departurePoint: { type: 'Point', coordinates: [15.31, -4.3] }, arrivalPoint: { type: 'Point', coordinates: [15.32, -4.3] },
      departureDateMin: new Date(Date.now() + 1000), departureDateMax: new Date(Date.now() + 2400000),
      numberOfSeats: seats, maxPricePerSeat: 1000, vehicleType: VehicleType.CAR });
  };
  const offers = (requestId: string) => source.query('SELECT * FROM trip_request_dispatch_offers WHERE "requestId" = $1 ORDER BY "createdAt"', [requestId]);

  it('does not let 30 requests without pickup points or a missing immediate price starve a valid request', async () => {
    await driver();
    const bad = await request();
    await source.getRepository(TripRequest).update(bad.id, { departurePoint: null });
    await source.getRepository(TripRequest).save(Array.from({ length: 29 }, () => ({ ...bad, id: randomUUID(), departurePoint: null })));
    const unpriced = await request();
    await source.getRepository(TripRequest).update(unpriced.id, { maxPricePerSeat: null });
    const valid = await request();
    await service.tick();
    expect(await offers(valid.id)).toHaveLength(1);
    expect(await offers(unpriced.id)).toHaveLength(0);
    expect(await source.query('SELECT * FROM trip_request_dispatch_offers')).toHaveLength(1);
  });

  it('realtime recovers a dead worker lease and deduplicates replicas without waiting for push', async () => {
    await driver(); const r = await request(); await service.tick();
    const [id] = await claimRideRealtimeNotifications(source.manager);
    expect(id).toBeDefined();
    expect(await claimRideRealtimeNotifications(source.manager)).toHaveLength(0);
    await source.query(`UPDATE ride_realtime_deliveries SET "attemptedAt" = now() - interval '6 seconds'`);
    const publish = jest.fn().mockReturnValue(true);
    const create = () => new NotificationService(new ConfigService({ DRIVER_DISPATCH_ENABLED: 'true' }),
      source.getRepository(Notification), source.getRepository(User), source.getRepository(TripRequest),
      { isBound: () => true, publish } as any);
    const workers = [create(), create()];
    workers.forEach(worker => { worker['urgentWorkers'] = 5; });
    await Promise.all(workers.map(worker => worker.dispatchRealtimeNotifications()));
    expect(publish).toHaveBeenCalledTimes(1);
    expect((await source.getRepository(Notification).findOneByOrFail({ id })).status).toBe('pending');
    expect((await source.query('SELECT * FROM ride_realtime_deliveries'))[0].completedAt).not.toBeNull();
  });

  it('reverts and reapplies resilience migration without losing requests or notifications', async () => {
    await driver(); const r = await request(); await service.tick();
    const migration = new DispatchDeliveryResilience1780000088000();
    const runner = source.createQueryRunner();
    try {
      await migration.down(runner); await migration.up(runner);
      expect(await offers(r.id)).toHaveLength(1);
      expect(await source.getRepository(Notification).count()).toBe(1);
    } finally { await runner.release(); }
  });

  it('skips a presence reserved after the candidate statement snapshot, without losing the successor', async () => {
    const closest = await driver(15.31), successor = await driver(15.311);
    const first = await request(), second = await request();
    const runner = source.createQueryRunner();
    let competing: Promise<void> | undefined;
    let candidateReads = 0;
    await runner.connect(); await runner.startTransaction();
    try {
      await runner.query('SELECT pg_advisory_xact_lock(782341)');
      competing = source.transaction(async manager => {
        const original = manager.query.bind(manager);
        // Acquire a statement snapshot, then wait before scanning candidates.
        // A different transaction commits the nearest driver's reservation meanwhile.
        manager.query = ((sql: string, params?: any[]) => {
          if (sql.startsWith('WITH candidates AS MATERIALIZED (')) {
            candidateReads++;
            sql = sql.replace('WITH candidates AS MATERIALIZED (',
                'WITH gate AS MATERIALIZED (SELECT pg_advisory_xact_lock(782341)), candidates AS MATERIALIZED (')
              .replace('FROM driver_dispatch_presence p', 'FROM driver_dispatch_presence p CROSS JOIN gate');
          }
          return original(sql, params);
        }) as typeof manager.query;
        const locked = await manager.getRepository(TripRequest).findOneOrFail({
          where: { id: second.id }, lock: { mode: 'pessimistic_write' },
        });
        await service['allocateNext'](manager, locked);
      });
      // Observe the actual blocked query rather than relying on a sleep's timing.
      const limit = Date.now() + 5000;
      let blocked = false;
      while (!blocked && Date.now() < limit) {
        const rows = await source.query("SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid=782341 AND NOT granted");
        blocked = rows.length > 0;
        if (!blocked) await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true);
      const locked = await runner.manager.getRepository(TripRequest).findOneOrFail({
        where: { id: first.id }, lock: { mode: 'pessimistic_write' },
      });
      await service['allocateNext'](runner.manager, locked);
      await runner.commitTransaction();
      await competing;
      expect(candidateReads).toBe(1);
      expect((await offers(first.id))[0].driverId).toBe(closest.user.id);
      expect(await offers(second.id)).toEqual([expect.objectContaining({ driverId: successor.user.id, status: 'pending' })]);
    } finally {
      if (runner.isTransactionActive) await runner.rollbackTransaction();
      await competing?.catch(() => undefined);
      await runner.release();
    }
  }, 15000);

  it('excludes a muted nearby driver from scheduled and immediate dispatch, then resumes after expiry', async () => {
    const d = await driver();
    await service.registerNotifications(d.user.id, 2);
    await source.query(`INSERT INTO nearby_driver_ring_state ("driverId", "missedCount", "mutedUntil")
      VALUES ($1,4,now() + interval '24 hours')`, [d.user.id]);
    const scheduled = await request(false), immediate = await request();
    await service.notifyScheduledRequest(scheduled.id); await service.tick();
    expect(await offers(immediate.id)).toHaveLength(0);
    expect(await source.query(`SELECT id FROM notifications WHERE "userId" = $1`, [d.user.id])).toHaveLength(0);
    expect((await service.status(d.user.id)).available).toBe(true);
    await source.query(`UPDATE nearby_driver_ring_state SET "mutedUntil" = now() - interval '1 second' WHERE "driverId" = $1`, [d.user.id]);
    await service.notifyScheduledRequest(scheduled.id); await service.tick();
    expect(await offers(immediate.id)).toHaveLength(1);
    expect(await source.query(`SELECT id FROM notifications WHERE "userId" = $1 AND data ->> 'type' = 'trip_request_nearby'`, [d.user.id])).toHaveLength(1);
  });

  it('hides old driver order alerts from a passenger inbox and unread counts while retaining own updates', async () => {
    const owner = await passenger();
    const repository = source.getRepository(Notification);
    for (const type of ['trip_request', 'new_trip_request', 'driver_dispatch_offer', 'trip_request_nearby', 'trip_request_accepted', 'trip_request_reopened']) {
      await repository.save({ userId: owner.id, fcmToken: 'synthetic-token', title: 'Test', body: 'Test', data: { type }, isActive: true, isRead: false });
    }
    const inbox = new NotificationService(new ConfigService(), repository, source.getRepository(User), source.getRepository(TripRequest));
    const result = await inbox.findAllByUser(owner.id, { limit: 1 });
    expect(result.notifications).toHaveLength(1); expect(result.total).toBe(2); expect(result.unreadCount).toBe(2);
    const all = await inbox.findAllByUser(owner.id);
    expect(all.notifications.map(n => n.data?.type).sort()).toEqual(['trip_request_accepted', 'trip_request_reopened']);
    await source.getRepository(User).update(owner.id, { role: UserRole.DRIVER, status: UserStatus.ACTIVE });
    expect((await inbox.findAllByUser(owner.id)).total).toBe(6);
    await source.getRepository(User).update(owner.id, { status: UserStatus.SUSPENDED });
    expect((await inbox.findAllByUser(owner.id)).total).toBe(2);
  });

  it('alerts legacy and current compatible drivers for tomorrow without assigning or blocking them', async () => {
    await driver(15.31, VehicleType.MOTORCYCLE_TWO_WHEELS, 2);
    await driver(15.311, VehicleType.CAR, 1);
    const legacy = await driver(15.312); // Receives an ordinary push, not exclusion.
    const near = await driver(15.313), far = await driver(15.32);
    await service.registerNotifications(near.user.id, 2); await service.registerNotifications(far.user.id, 2);
    const r = await request(false, 2);
    await source.getRepository(TripRequest).update(r.id, {
      departureDateMin: new Date(Date.now() + 86_400_000), departureDateMax: new Date(Date.now() + 90_000_000),
    });
    await Promise.all([service.notifyScheduledRequest(r.id), service.notifyScheduledRequest(r.id)]);
    const rows = await source.query('SELECT * FROM notifications WHERE "eventKey" LIKE $1', [`nearby-scheduled-request:${r.id}:%`]);
    expect(rows).toHaveLength(3); expect(rows.map(row => row.userId).sort()).toEqual([legacy.user.id, near.user.id, far.user.id].sort());
    expect(rows[0].data).toMatchObject({ type: 'trip_request_nearby', ringAlert: 'nearby-request-v1' });
    expect(await offers(r.id)).toHaveLength(0);
    expect(await source.getRepository(TripRequest).findOneByOrFail({ id: r.id })).toMatchObject({ status: 'pending', selectedDriverId: null });
    expect((await service.status(near.user.id)).available).toBe(true);
  });

  it('does not ring an explicitly disabled or out-of-radius position for a scheduled request', async () => {
    const stale = await driver(15.31), distant = await driver(16.3);
    await service.registerNotifications(stale.user.id, 2); await service.registerNotifications(distant.user.id, 2);
    await service.setPresence(stale.user.id, { available: false });
    const r = await request(false); await service.notifyScheduledRequest(r.id);
    expect(await source.query('SELECT id FROM notifications WHERE "eventKey" LIKE $1', [`nearby-scheduled-request:${r.id}:%`])).toHaveLength(0);
  });

  it('migrates and rolls back the urgent index without altering notification rows', async () => {
    const migration = new IndexNearbyRequestAlerts1780000066000();
    const runner = source.createQueryRunner();
    try {
      await runner.startTransaction(); await migration.up(runner); await runner.commitTransaction();
      const [index] = await source.query("SELECT indexdef FROM pg_indexes WHERE indexname = 'IDX_notifications_urgent_outbox_v2'");
      expect(index.indexdef).toContain('trip_request_nearby');
      await runner.startTransaction(); await migration.down(runner); await runner.commitTransaction();
      expect(await source.query("SELECT 1 FROM pg_indexes WHERE indexname = 'IDX_notifications_urgent_outbox'")).toHaveLength(1);
      await runner.startTransaction(); await migration.up(runner); await runner.commitTransaction();
    } finally { if (runner.isTransactionActive) await runner.rollbackTransaction(); await runner.release(); }
  });

  const editor = () => {
    const edits = new TripRequestsService(source.getRepository(TripRequest), source.getRepository(DriverOffer),
      source.getRepository(User), source.getRepository(Vehicle), {} as never, {} as never, {} as never,
      {} as never, {} as never, {} as never, {} as never, {} as never);
    jest.spyOn(edits, 'findOne').mockImplementation(async id => source.getRepository(TripRequest).findOneByOrFail({ id }) as never);
    jest.spyOn(edits as any, 'notifyPassengerAboutDriverOffer').mockResolvedValue(undefined);
    jest.spyOn(edits as any, 'notifyDriverAboutOfferAcceptance').mockResolvedValue(undefined);
    jest.spyOn(edits as any, 'sanitizeDriverOffer').mockImplementation(async offer => offer);
    return edits;
  };

  it('publishes a terminal hint after a classical offer acceptance using a partial TypeORM update', async () => {
    const d = await driver(), r = await request(false), edits = editor();
    const offer = await edits.createDriverOffer(d.user.id, r.id, { vehicleId: d.vehicle.id,
      proposedDepartureDate: new Date(Date.now() + 60000).toISOString(), pricePerSeat: 1000, availableSeats: 1 });
    const publish = jest.fn(), changes = new RideAlertChanges(source, { publish } as any);
    try {
      await edits.acceptDriverOffer(r.passengerId, r.id, { offerId: offer.id });
      for (let attempt = 0; attempt < 100 && publish.mock.calls.length < 2; attempt++)
        await new Promise(resolve => setTimeout(resolve, 20));
      expect(publish).toHaveBeenCalledWith(d.user.id, { kind: 'changed', requestId: r.id, terminal: true });
      expect(publish).toHaveBeenCalledWith(r.passengerId, { kind: 'changed', requestId: r.id, terminal: true });
    } finally { changes.onModuleDestroy(); }
  });

  it('expires concurrent requests with one durable outbox event and no HTTP inside the transaction', async () => {
    const r = await request(false);
    await source.getRepository(TripRequest).update(r.id, { departureDateMax: new Date(Date.now() - 4 * 3600_000) });
    await Promise.all([editor().markExpiredTripRequests(), editor().markExpiredTripRequests()]);
    expect((await source.getRepository(TripRequest).findOneByOrFail({ id: r.id })).status).toBe('expired');
    const events = await source.query(`SELECT * FROM notifications WHERE data ->> 'tripRequestId' = $1`, [r.id]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ status: 'pending', data: { type: 'trip_request_expired' } });
  });

  it.each(['expiration', 'overdue'])('rolls back %s state when the outbox cannot be persisted', async kind => {
    const r = await request(false), d = await driver();
    const overdue = kind === 'overdue';
    await source.getRepository(TripRequest).update(r.id, {
      departureDateMax: new Date(Date.now() - (overdue ? 5 * 60_000 : 4 * 3600_000)),
      status: overdue ? TripRequestStatus.DRIVER_SELECTED : TripRequestStatus.PENDING,
      selectedDriverId: overdue ? d.user.id : null,
    });
    await source.query(`ALTER TABLE notifications ADD CONSTRAINT audit_fail_outbox CHECK (false) NOT VALID`);
    const run = () => overdue ? editor().notifyPassengersAboutOverdueDriverPickup() : editor().markExpiredTripRequests();
    try {
      await expect(run()).rejects.toThrow();
      const current = await source.getRepository(TripRequest).findOneByOrFail({ id: r.id });
      expect(current.status).toBe(overdue ? 'driver_selected' : 'pending');
      expect(current.driverPickupOverdueNotifiedAt).toBeNull();
      expect(await source.getRepository(Notification).count()).toBe(0);
    } finally { await source.query('ALTER TABLE notifications DROP CONSTRAINT audit_fail_outbox'); }
    await run(); await run();
    expect(await source.getRepository(Notification).count()).toBe(1);
  });

  it('bounds each expiration tick to 100 requests and processes the remainder on the next tick', async () => {
    const base = await request(false), repository = source.getRepository(TripRequest);
    await repository.save(Array.from({ length: 100 }, () => repository.create({ ...base, id: randomUUID() })));
    await repository.update({ passengerId: base.passengerId }, { departureDateMax: new Date(Date.now() - 4 * 3600_000) });
    await editor().markExpiredTripRequests();
    expect(await repository.countBy({ status: TripRequestStatus.EXPIRED })).toBe(100);
    expect(await source.getRepository(Notification).count()).toBe(100);
    await editor().markExpiredTripRequests();
    expect(await repository.countBy({ status: TripRequestStatus.EXPIRED })).toBe(101);
  });

  it('does not let unaccepted requests in their third hour starve accepted requests past two hours', async () => {
    const base = await request(false), repository = source.getRepository(TripRequest);
    await repository.save(Array.from({ length: 100 }, () => repository.create({ ...base, id: randomUUID() })));
    await repository.update({ passengerId: base.passengerId }, { departureDateMax: new Date(Date.now() - 150 * 60_000) });
    const accepted = await request(false), d = await driver();
    await repository.update(accepted.id, { status: TripRequestStatus.DRIVER_SELECTED, selectedDriverId: d.user.id,
      departureDateMax: new Date(Date.now() - 135 * 60_000) });
    await editor().markExpiredTripRequests();
    expect(await repository.countBy({ status: TripRequestStatus.EXPIRED })).toBe(1);
    expect((await repository.findOneByOrFail({ id: accepted.id })).status).toBe('expired');
    expect(await repository.countBy({ status: TripRequestStatus.PENDING })).toBe(101);
  });

  it('editing cancels an old dispatch invitation atomically, and stale acceptance is refused', async () => {
    const d = await driver(); const r = await request(); await service.tick();
    const [offer] = await offers(r.id);
    await editor().update(r.passengerId, r.id, { description: 'Entrée côté rue' });
    expect((await offers(r.id))[0].status).toBe('cancelled');
    await expect(service.respond(d.user.id, offer.id, 'accept')).rejects.toThrow();
    expect((await source.getRepository(TripRequest).findOneByOrFail({ id: r.id })).selectedDriverId).toBeNull();
  });

  it('background dispatch checks do not invalidate an open edit form', async () => {
    await driver(); const r = await request();
    await service.tick(); await service.tick();
    const current = await source.getRepository(TripRequest).findOneByOrFail({ id: r.id });
    expect(current.updatedAt.getTime()).toBe(r.updatedAt.getTime());
    await expect(editor().update(r.passengerId, r.id, { expectedUpdatedAt: r.updatedAt.toISOString(), description: 'Repère ajouté' })).resolves.toMatchObject({ description: 'Repère ajouté' });
  });

  it('one of a concurrent edit and dispatch acceptance wins; the loser cannot change the assignment', async () => {
    const d = await driver(); const r = await request(); await service.tick(); const [offer] = await offers(r.id);
    const result = await Promise.allSettled([
      editor().update(r.passengerId, r.id, { description: 'Nouvelles conditions' }),
      service.respond(d.user.id, offer.id, 'accept'),
    ]);
    expect(result.filter(item => item.status === 'fulfilled')).toHaveLength(1);
    const final = await source.getRepository(TripRequest).findOneByOrFail({ id: r.id });
    if (result[0].status === 'fulfilled') {
      expect(final.description).toBe('Nouvelles conditions');
      expect(final.selectedDriverId).toBeNull();
    } else {
      expect(final.status).toBe('driver_selected');
      expect(final.description).not.toBe('Nouvelles conditions');
    }
  });

  it('editing a classical request retires persisted offers; those old terms cannot be accepted', async () => {
    const d = await driver(); const r = await request(false); const edits = editor();
    const offer = await edits.createDriverOffer(d.user.id, r.id, { vehicleId: d.vehicle.id,
      proposedDepartureDate: new Date(Date.now() + 60000).toISOString(), pricePerSeat: 1000, availableSeats: 1 });
    await edits.update(r.passengerId, r.id, { description: 'Nouveau point de rencontre' });
    expect((await source.getRepository(DriverOffer).findOneByOrFail({ id: offer.id })).status).toBe('rejected');
    await expect(edits.acceptDriverOffer(r.passengerId, r.id, { offerId: offer.id })).rejects.toThrow('disponible');
    const replacement = await edits.createDriverOffer(d.user.id, r.id, { vehicleId: d.vehicle.id,
      proposedDepartureDate: new Date(Date.now() + 60000).toISOString(), pricePerSeat: 1000, availableSeats: 1 });
    await expect(edits.acceptDriverOffer(r.passengerId, r.id, { offerId: replacement.id })).resolves.toMatchObject({ status: 'driver_selected', selectedDriverId: d.user.id });
    expect((await source.getRepository(DriverOffer).findOneByOrFail({ id: offer.id })).status).toBe('rejected');
  });

  it('invites drivers one by one by distance, immediately after refusal, and stops on acceptance', async () => {
    const near = await driver(), next = await driver(15.315), far = await driver(15.32);
    await driver(15.325);
    const r = await request();
    await service.tick(); const invitations = await offers(r.id);
    expect(invitations).toHaveLength(1);
    const [first] = invitations;
    expect(first.driverId).toBe(near.user.id);
    await service.tick();
    expect(await offers(r.id)).toHaveLength(1);
    await service.respond(near.user.id, first.id, 'decline');
    const second = (await offers(r.id)).find(offer => offer.status === 'pending');
    expect(second.driverId).toBe(next.user.id);
    expect(new Date(second.expiresAt).getTime() - Date.now()).toBeGreaterThan(25_000);
    expect((await source.getRepository(TripRequest).findOneByOrFail({ id: r.id })).status).toBe('pending');
    await service.respond(next.user.id, second.id, 'decline');
    const third = (await offers(r.id)).find(offer => offer.status === 'pending');
    expect(third.driverId).toBe(far.user.id);
    await service.respond(far.user.id, third.id, 'accept');
    await service.tick();
    expect((await offers(r.id)).map(o => o.status)).toEqual(['declined', 'declined', 'accepted']);
    expect((await source.getRepository(TripRequest).findOneByOrFail({ id: r.id })).selectedDriverId).toBe(far.user.id);
    expect(await source.getRepository(Notification).countBy({ eventKey: `dispatch-offer:${second.id}` })).toBe(1);
  });
  it('commits the successor and its push before responding even when the global cron is busy', async () => {
    const d = await driver(), next = await driver(15.32), r = await request();
    await service['allocate'](r.id);
    const [offer] = await offers(r.id);
    service['ticking'] = true;
    try {
      await expect(service.respond(d.user.id, offer.id, 'decline')).resolves.toMatchObject({ status: 'declined' });
      const pending = (await offers(r.id)).find(o => o.status === 'pending');
      expect(pending.driverId).toBe(next.user.id);
      expect(await source.getRepository(Notification).countBy({ eventKey: `dispatch-offer:${pending.id}` })).toBe(1);
      expect(notifications.dispatchUrgentNotifications).toHaveBeenCalledTimes(1);
      expect(dispatchCycles).not.toHaveBeenCalled();
    } finally { service['ticking'] = false; }
  });

  it('deduplicates concurrent refusals and cron allocation without skipping the next driver', async () => {
    const d = await driver(), next = await driver(15.32), r = await request();
    await driver(15.33);
    await service['allocate'](r.id);
    const [offer] = await offers(r.id);
    await Promise.all([service.respond(d.user.id, offer.id, 'decline'),
      service.respond(d.user.id, offer.id, 'decline'), service['allocate'](r.id)]);
    await service.respond(d.user.id, offer.id, 'decline');
    const current = await offers(r.id);
    expect(current).toHaveLength(2);
    expect(current.filter(o => o.status === 'pending').map(o => o.driverId)).toEqual([next.user.id]);
    expect(await source.query(`SELECT id FROM notifications WHERE data ->> 'type' = 'driver_dispatch_offer'
      AND data ->> 'tripRequestId' = $1`, [r.id])).toHaveLength(2);
  });

  it('keeps an exhausted request open without re-inviting refusals and can find a newly available driver', async () => {
    const d = await driver(), r = await request();
    await service['allocate'](r.id);
    const [offer] = await offers(r.id);
    await service.respond(d.user.id, offer.id, 'decline');
    await service.tick(); await service.tick();
    expect((await offers(r.id)).map(o => o.status)).toEqual(['declined']);
    const next = await driver(15.32);
    await service.tick();
    expect((await offers(r.id)).find(o => o.status === 'pending').driverId).toBe(next.user.id);
  });

  it.each(['cancelled', 'expired', 'assigned'])('does not advance a request that is %s', async state => {
    const d = await driver(), next = await driver(15.32), r = await request();
    await service['allocate'](r.id);
    const [offer] = await offers(r.id);
    await source.getRepository(TripRequest).update(r.id, state === 'expired'
      ? { departureDateMax: new Date(Date.now() - 1) }
      : state === 'assigned' ? { selectedDriverId: next.user.id }
        : { status: TripRequestStatus.CANCELLED });
    await expect(service.respond(d.user.id, offer.id, 'decline')).rejects.toThrow();
    await service['allocate'](r.id);
    expect(await offers(r.id)).toHaveLength(1);
  });
  it('a recent position automatically makes a v2 driver eligible, without availability or vehicle setup', async () => {
    const d = await driver();
    await source.query('DELETE FROM driver_dispatch_presence WHERE "driverId" = $1', [d.user.id]);
    await service.registerNotifications(d.user.id, 2);
    const state = await service.recordPosition(d.user.id, { latitude: -4.3, longitude: 15.31,
      accuracy: 20, recordedAt: new Date().toISOString() });
    expect(state).toMatchObject({ available: true, automatic: true, positionFreshSeconds: 300 });
    const r = await request();
    await service.tick();
    const [offer] = await offers(r.id);
    expect(offer.driverId).toBe(d.user.id);
    await expect(service.respond(d.user.id, offer.id, 'accept')).resolves.toMatchObject({ status: 'accepted' });
  });
  it('selects another compatible owned vehicle automatically and preserves it on the next GPS update', async () => {
    const d = await driver(15.31, VehicleType.MOTORCYCLE_TWO_WHEELS, 2);
    const car = await source.getRepository(Vehicle).save({ ownerId: d.user.id, brand: 'Test', model: 'Test',
      color: 'Test', licensePlate: randomUUID(), type: VehicleType.CAR });
    const r = await request(); await service.tick();
    const [offer] = await offers(r.id);
    expect(offer.vehicleId).toBe(car.id);
    const state = await service.recordPosition(d.user.id, { latitude: -4.3, longitude: 15.31, accuracy: 20, recordedAt: new Date().toISOString() });
    expect('presence' in state && state.presence.vehicleId).toBe(car.id);
    await expect(service.respond(d.user.id, offer.id, 'accept')).resolves.toMatchObject({ status: 'accepted' });
  });
  it.each([true, false])('uses an old received position for dispatch without an age limit (immediate=%s)', async immediate => {
    const d = await driver();
    await source.query('DELETE FROM driver_dispatch_presence WHERE "driverId" = $1', [d.user.id]);
    const recordedAt = new Date(Date.now() - 90 * 86_400_000).toISOString();
    const state = await service.recordPosition(d.user.id, { latitude: -4.3, longitude: 15.31, accuracy: 20, recordedAt });
    expect(state).toMatchObject({ available: true, locationPolicy: 'last_known', positionExpires: false });
    const r = await request(immediate);
    if (immediate) {
      await service['allocate'](r.id);
      const [offer] = await offers(r.id);
      expect(offer.driverId).toBe(d.user.id);
      await expect(service.respond(d.user.id, offer.id, 'accept')).resolves.toMatchObject({ status: 'accepted' });
      expect((await service.status(d.user.id)).available).toBe(false); // Busy, not expired GPS.
    } else {
      await expect(service.notifyScheduledRequest(r.id)).resolves.toBe(true);
      const rows = await source.query('SELECT "userId" FROM notifications WHERE data ->> \'tripRequestId\' = $1', [r.id]);
      expect(rows.map(row => row.userId)).toEqual([d.user.id]);
    }
  });

  it('does not replace a newer known position with a delayed older sample', async () => {
    const d = await driver();
    await source.query('DELETE FROM driver_dispatch_presence WHERE "driverId" = $1', [d.user.id]);
    const latest = new Date(Date.now() - 86_400_000).toISOString();
    await service.recordPosition(d.user.id, { latitude: -4.3, longitude: 15.31, accuracy: 20, recordedAt: latest });
    await service.recordPosition(d.user.id, { latitude: -4.3, longitude: 16.3, accuracy: 20,
      recordedAt: new Date(Date.now() - 2 * 86_400_000).toISOString() });
    const [row] = await source.query('SELECT ST_X(position::geometry) AS longitude, "updatedAt" FROM driver_dispatch_presence WHERE "driverId" = $1', [d.user.id]);
    expect(row.longitude).toBe(15.31);
    expect(row.updatedAt.toISOString()).toBe(latest);
  });

  it('preserves an explicit opt-out across GPS updates and late legacy heartbeats', async () => {
    const d = await driver();
    const leaseId = 'presence' in d.presence ? d.presence.presence.leaseId : '';
    await service.setPresence(d.user.id, { available: false });
    await service.recordPosition(d.user.id, { latitude: -4.3, longitude: 15.31, accuracy: 20, recordedAt: new Date().toISOString() });
    await service.setPresence(d.user.id, { available: true, leaseId, vehicleId: d.vehicle.id, seats: 4, latitude: -4.3, longitude: 15.31 });
    expect((await service.status(d.user.id)).available).toBe(false);
    const r = await request(); await service['allocate'](r.id);
    expect(await offers(r.id)).toHaveLength(0);
    await service.setPresence(d.user.id, { available: true, vehicleId: d.vehicle.id, seats: 4, latitude: -4.3, longitude: 15.31 });
    expect((await service.status(d.user.id)).available).toBe(true);
  });

  it('preserves legacy expired rows until a subsequent GPS update, without a blanket reactivation', async () => {
    const d = await driver();
    await source.query(`UPDATE driver_dispatch_presence SET "discoveryEnabled" = NULL,
      "updatedAt" = now() - interval '8 days', "expiresAt" = now() - interval '7 days' WHERE "driverId" = $1`, [d.user.id]);
    expect((await service.status(d.user.id)).available).toBe(false);
    await service.recordPosition(d.user.id, { latitude: -4.3, longitude: 15.31, accuracy: 20,
      recordedAt: new Date(Date.now() - 86_400_000).toISOString() });
    expect((await service.status(d.user.id)).available).toBe(true);
  });

  it('keeps locations but does not invite a driver while already assigned to a request', async () => {
    const d = await driver(), assigned = await request();
    await source.query(`UPDATE trip_requests SET status = 'driver_selected', "selectedDriverId" = $2 WHERE id = $1`, [assigned.id, d.user.id]);
    await service.recordPosition(d.user.id, { latitude: -4.3, longitude: 15.312, accuracy: 20, recordedAt: new Date().toISOString() });
    const [row] = await source.query('SELECT ST_X(position::geometry) AS longitude FROM driver_dispatch_presence WHERE "driverId" = $1', [d.user.id]);
    expect(row.longitude).toBe(15.312);
    const next = await request(); await service['allocate'](next.id);
    expect(await offers(next.id)).toHaveLength(0);
  });

  it('applies and rolls back the additive location migration without changing stored positions', async () => {
    const d = await driver(), migration = new RetainDriverLastLocation1780000076000();
    const runner = source.createQueryRunner();
    try {
      await migration.down(runner);
      const [before] = await source.query('SELECT "updatedAt", ST_AsText(position) AS point FROM driver_dispatch_presence WHERE "driverId" = $1', [d.user.id]);
      await migration.up(runner);
      const [after] = await source.query('SELECT "updatedAt", ST_AsText(position) AS point, "discoveryEnabled" FROM driver_dispatch_presence WHERE "driverId" = $1', [d.user.id]);
      expect(after).toEqual({ ...before, discoveryEnabled: null });
    } finally { await runner.release(); }
  });
  it('does not dispatch scheduled requests, stale positions or incompatible vehicles', async () => {
    await driver(15.31, VehicleType.MOTORCYCLE_TWO_WHEELS, 2);
    const car = await driver();
    await service.setPresence(car.user.id, { available: false });
    const scheduled = await request(false); const immediate = await request();
    await service.tick();
    expect(await offers(scheduled.id)).toHaveLength(0); expect(await offers(immediate.id)).toHaveLength(0);
  });
  it('accepts once under simultaneous retries and protects ownership and processed offers', async () => {
    const d = await driver(); const r = await request(); await service.tick(); const [offer] = await offers(r.id);
    await expect(service.respond(randomUUID(), offer.id, 'accept')).rejects.toThrow('introuvable');
    const results = await Promise.all([service.respond(d.user.id, offer.id, 'accept'), service.respond(d.user.id, offer.id, 'accept')]);
    expect(results.map(v => v.status)).toEqual(['accepted', 'accepted']);
    expect((await source.query('SELECT * FROM driver_offers WHERE "tripRequestId" = $1', [r.id]))).toHaveLength(1);
    expect((await source.query('SELECT * FROM notifications WHERE "eventKey" = $1', [`dispatch-accepted:${offer.id}`]))).toHaveLength(1);
    await expect(service.respond(d.user.id, offer.id, 'decline')).rejects.toThrow('traitée');
    expect((await service.status(d.user.id)).available).toBe(false);
  });
  it('publishes cancellation hints to the passenger and invited driver only after commit', async () => {
    const d = await driver(); const r = await request(); await service.tick();
    const publish = jest.fn();
    const changes = new RideAlertChanges(source, { publish } as any);
    try {
      await source.transaction(async manager => {
        const request = await manager.getRepository(TripRequest).findOneByOrFail({ id: r.id });
        request.status = TripRequestStatus.CANCELLED;
        await manager.getRepository(TripRequest).save(request);
        expect(publish).not.toHaveBeenCalled();
      });
      for (let attempt = 0; attempt < 100 && publish.mock.calls.length < 2; attempt++)
        await new Promise(resolve => setTimeout(resolve, 20));
      expect(new Set(publish.mock.calls.map(call => call[0]))).toEqual(new Set([d.user.id, r.passengerId]));
      expect(publish.mock.calls.every(call => call[1].terminal === true && call[1].requestId === r.id)).toBe(true);
    } finally { changes.onModuleDestroy(); }
  });
  it('a timeout advances to the next driver and a delayed push cannot resurrect the old invitation', async () => {
    const near = await driver(); const far = await driver(15.32); const r = await request();
    await service.tick(); const first = (await offers(r.id)).find(o => o.driverId === near.user.id);
    await source.query('UPDATE trip_request_dispatch_offers SET "expiresAt" = now() - interval \'1 second\' WHERE id = $1', [first.id]);
    await expect(service.respond(near.user.id, first.id, 'accept')).rejects.toThrow('expiré');
    await service.tick();
    expect((await offers(r.id)).find(o => o.driverId === far.user.id).status).toBe('pending');
    expect((await offers(r.id)).find(o => o.driverId === near.user.id).status).toBe('expired');
    const oldPush = await source.getRepository(Notification).findOneByOrFail({ eventKey: `dispatch-offer:${first.id}` });
    oldPush.data!.expiresAt = new Date(Date.now() - 1000).toISOString();
    expect((await offers(r.id)).filter(o => o.status === 'pending').map(o => o.driverId)).toEqual([far.user.id]);
    const delivery = new NotificationService(new ConfigService({ DRIVER_DISPATCH_ENABLED: 'true' }),
      source.getRepository(Notification), source.getRepository(User), source.getRepository(TripRequest));
    expect(await delivery['isCriticalNotificationStillDeliverable'](oldPush)).toBe(false);
  });
  it('a late heartbeat cannot reactivate a driver who went offline', async () => {
    const d = await driver(); const leaseId = d.presence.presence.leaseId;
    await service.setPresence(d.user.id, { available: false });
    await service.setPresence(d.user.id, { available: true, vehicleId: d.vehicle.id, seats: 4, latitude: -4.3, longitude: 15.31, leaseId });
    expect((await service.status(d.user.id)).available).toBe(false);
  });

  it('does not allocate a second invitation for one request even across concurrent workers', async () => {
    const a = await driver(), r = await request(); await driver(15.32);
    await Promise.all([service['allocate'](r.id), service['allocate'](r.id)]);
    await service['allocate'](r.id);
    expect((await offers(r.id)).map(o => o.driverId)).toEqual([a.user.id]);
  });

  it('does not reserve the same driver for two simultaneous requests', async () => {
    await driver(); await driver(15.32);
    const a = await request(), b = await request();
    await Promise.all([service['allocate'](a.id), service['allocate'](b.id)]);
    await service['allocate'](a.id); await service['allocate'](b.id);
    const first = await offers(a.id), second = await offers(b.id);
    expect(first).toHaveLength(1); expect(second).toHaveLength(1);
    expect(first[0].driverId).not.toBe(second[0].driverId);
  });

  const legacyBroadcast = async (requestId: string, d: Awaited<ReturnType<typeof driver>>) => {
    await source.query(`INSERT INTO trip_request_dispatch_offers (id,"requestId","driverId","vehicleId",seats,"expiresAt")
      VALUES ($1,$2,$3,$4,4,now() + interval '30 seconds')`, [randomUUID(), requestId, d.user.id, d.vehicle.id]);
  };

  it('only one driver wins concurrent acceptance of invitations left by the old broadcast version', async () => {
    const a = await driver(), b = await driver(15.32), r = await request();
    await service['allocate'](r.id);
    await legacyBroadcast(r.id, b);
    const invitations = await offers(r.id);
    expect(invitations).toHaveLength(2);
    const results = await Promise.allSettled(invitations.map(o => service.respond(o.driverId, o.id, 'accept')));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const current = await offers(r.id);
    expect(current.filter(o => o.status === 'accepted')).toHaveLength(1);
    expect(current.filter(o => o.status === 'cancelled')).toHaveLength(1);
    const selected = await source.getRepository(TripRequest).findOneByOrFail({ id: r.id });
    expect([a.user.id, b.user.id]).toContain(selected.selectedDriverId);
    expect(await source.getRepository(DriverOffer).countBy({ tripRequestId: r.id })).toBe(1);
  });

  it('lets the remaining legacy broadcast invitation finish before starting another turn', async () => {
    const a = await driver(), b = await driver(15.32), c = await driver(15.33), r = await request();
    await service['allocate'](r.id); await legacyBroadcast(r.id, b);
    const first = (await offers(r.id)).find(o => o.driverId === a.user.id);
    await service.respond(a.user.id, first.id, 'decline');
    expect(await offers(r.id)).toHaveLength(2);
    const second = (await offers(r.id)).find(o => o.driverId === b.user.id);
    await service.respond(b.user.id, second.id, 'decline');
    expect((await offers(r.id)).filter(o => o.status === 'pending').map(o => o.driverId)).toEqual([c.user.id]);
  });

  it.each([true, false])('can reach more than 50 drivers without duplicate alerts (immediate=%s)', async immediate => {
    for (let i = 0; i < 52; i++) {
      const d = await driver(15.31 + i * 0.00001); await service.registerNotifications(d.user.id, 2);
    }
    const r = await request(immediate);
    const run = () => immediate ? service['allocate'](r.id) : service.notifyScheduledRequest(r.id);
    await run(); await run(); await run();
    if (immediate) {
      expect(await offers(r.id)).toHaveLength(1);
      for (let i = 0; i < 52; i++) {
        const [offer] = (await offers(r.id)).filter(o => o.status === 'pending');
        expect(offer).toBeDefined();
        await service.respond(offer.driverId, offer.id, 'decline');
      }
      expect(await offers(r.id)).toHaveLength(52);
      expect((await offers(r.id)).every(o => o.status === 'declined')).toBe(true);
    }
    const notifications = await source.query(`SELECT * FROM notifications WHERE data ->> 'tripRequestId' = $1`, [r.id]);
    expect(notifications).toHaveLength(52);
    expect(new Set(notifications.map(n => n.userId)).size).toBe(52);
  }, 30000);

  it.each([true, false])('reaches eligible drivers independently of sound registration (immediate=%s)', async immediate => {
    const clients = [await driver(), await driver(15.312), await driver(15.313), await driver(15.314), await driver(15.315)];
    await source.query('DELETE FROM driver_notification_clients WHERE "userId" = $1', [clients[0].user.id]);
    await service.registerNotifications(clients[2].user.id, 2);
    await service.registerNotifications(clients[3].user.id, 3);
    // Rotation invalidates the previous capability hash, not ordinary delivery.
    await source.getRepository(User).update(clients[4].user.id, { fcmToken: `rotated-${randomUUID()}` });
    const outside = await driver(16.3), incompatible = await driver(15.31, VehicleType.MOTORCYCLE_TWO_WHEELS, 2), stale = await driver();
    await service.setPresence(stale.user.id, { available: false });
    const r = await request(immediate);
    const run = () => immediate ? service['allocate'](r.id) : service.notifyScheduledRequest(r.id);
    await Promise.all([run(), run()]);
    if (immediate) {
      for (const client of clients) {
        const [offer] = (await offers(r.id)).filter(o => o.status === 'pending');
        expect(offer.driverId).toBe(client.user.id);
        await service.respond(offer.driverId, offer.id, 'decline');
      }
    }
    const rows = await source.query('SELECT "userId" FROM notifications WHERE data ->> \'tripRequestId\' = $1', [r.id]);
    expect(rows.map(row => row.userId).sort()).toEqual(clients.map(client => client.user.id).sort());
    for (const excluded of [outside, incompatible, stale]) expect(rows.map(row => row.userId)).not.toContain(excluded.user.id);
    expect(await offers(r.id)).toHaveLength(immediate ? clients.length : 0);
  });

  it('includes just inside 5 km, excludes just outside and ignores former radius overrides', async () => {
    const inside = await driver(), outside = await driver();
    for (const [d, distance] of [[inside, 4999], [outside, 5001]] as const) {
      await source.query(`UPDATE driver_dispatch_presence SET position = ST_Project(
        ST_SetSRID(ST_MakePoint(15.31, -4.3),4326)::geography,$2::double precision,0::double precision)
        WHERE "driverId" = $1`, [d.user.id, distance]);
    }
    const r = await request(); await service['allocate'](r.id);
    expect((await offers(r.id)).map(o => o.driverId)).toEqual([inside.user.id]);
    const overridden = new DriverDispatchService(source, new ConfigService({ DRIVER_DISPATCH_RADIUS_METERS: '20000' }), {} as never);
    expect(overridden['radiusMeters']).toBe(5000);
  });

  it('reminds only after 6 hours, once across workers, resets on fresh GPS and suppresses stale pushes', async () => {
    const d = await driver();
    const queue = () => source.transaction(manager => enqueueStaleLocationReminders(manager));
    expect(await queue()).toBe(0);
    await source.query(`UPDATE driver_dispatch_presence SET "updatedAt" = now() - interval '5 hours 59 minutes',
      "expiresAt" = now() - interval '5 hours' WHERE "driverId" = $1`, [d.user.id]);
    expect(await queue()).toBe(0);
    await source.query(`UPDATE driver_dispatch_presence SET "updatedAt" = now() - interval '6 hours 1 minute' WHERE "driverId" = $1`, [d.user.id]);
    const runs = await Promise.all([queue(), queue()]); expect(runs.reduce((a, b) => a + b)).toBe(1);
    expect(await queue()).toBe(0);
    const [notification] = await source.getRepository(Notification).findBy({ userId: d.user.id });
    expect(notification.data).toMatchObject({ type: 'driver_location_stale', driverId: d.user.id });
    expect(notification.data).not.toHaveProperty('latitude'); expect(notification.data).not.toHaveProperty('ringAlert');
    expect(await isStaleLocationReminderDeliverable(source.manager, notification)).toBe(true);
    await service.recordPosition(d.user.id, { latitude: -4.3, longitude: 15.31, accuracy: 20, recordedAt: new Date().toISOString() });
    expect(await isStaleLocationReminderDeliverable(source.manager, notification)).toBe(false);
    expect(await queue()).toBe(0);
    await source.query(`UPDATE driver_dispatch_presence SET "updatedAt" = now() - interval '7 hours',
      "expiresAt" = now() - interval '6 hours' WHERE "driverId" = $1`, [d.user.id]);
    expect(await queue()).toBe(1);
    expect(await source.getRepository(Notification).countBy({ userId: d.user.id })).toBe(2);
  });

  it('does not remind a passenger, suspended driver, driver without a token or driver on a trip', async () => {
    const riders = [await driver(), await driver(), await driver(), await driver()];
    await source.query(`UPDATE driver_dispatch_presence SET "updatedAt" = now() - interval '7 hours'`);
    await source.getRepository(User).update(riders[0].user.id, { role: UserRole.PASSENGER });
    await source.getRepository(User).update(riders[1].user.id, { status: UserStatus.SUSPENDED });
    await source.getRepository(User).update(riders[2].user.id, { fcmToken: '' });
    const r = await request();
    await source.query(`UPDATE trip_requests SET status = 'driver_selected', "selectedDriverId" = $2 WHERE id = $1`, [r.id, riders[3].user.id]);
    expect(await source.transaction(manager => enqueueStaleLocationReminders(manager))).toBe(0);
  });

  it('refuses destructive rollback with live broadcasts, then restores/reapplies the schema without deleting offers', async () => {
    await driver(); const second = await driver(15.32); const r = await request(); await service['allocate'](r.id);
    await legacyBroadcast(r.id, second);
    const migration = new BroadcastDriverRequests1780000074000(), runner = source.createQueryRunner();
    try {
      await runner.startTransaction();
      await expect(migration.down(runner)).rejects.toThrow('Broadcast invitations still pending');
      await runner.rollbackTransaction();
      expect(await offers(r.id)).toHaveLength(2);
      await source.query(`UPDATE trip_request_dispatch_offers SET status = 'expired' WHERE "requestId" = $1`, [r.id]);
      await runner.startTransaction(); await migration.down(runner); await runner.commitTransaction();
      await runner.startTransaction(); await migration.up(runner); await runner.commitTransaction();
      expect(await offers(r.id)).toHaveLength(2);
    } finally { if (runner.isTransactionActive) await runner.rollbackTransaction(); await runner.release(); }
  });
});
