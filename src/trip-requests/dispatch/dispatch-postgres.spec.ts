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
  const waitForDispatchCycles = async () => {
    // respond() deliberately starts tick() without awaiting it. Calling tick()
    // again cannot drain that work: its single-flight guard returns immediately.
    // Keep the real implementation and wait for every promise it already returned.
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
    } finally { await runner.release(); }
    service = new DriverDispatchService(source, new ConfigService({ DRIVER_DISPATCH_ENABLED: 'true' }),
      { dispatchTransactionalNotifications: jest.fn().mockResolvedValue(undefined) } as never);
    dispatchCycles = jest.spyOn(service, 'tick');
  }, 60000);
  beforeEach(async () => {
    await waitForDispatchCycles();
    await source.query('TRUNCATE users CASCADE');
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

  it('alerts all compatible current v2 drivers for tomorrow without assigning or blocking them', async () => {
    await driver(15.31, VehicleType.MOTORCYCLE_TWO_WHEELS, 2);
    await driver(15.311, VehicleType.CAR, 1);
    await driver(15.312); // Legacy installation: not a long-ring target.
    const near = await driver(15.313), far = await driver(15.32);
    await service.registerNotifications(near.user.id, 2); await service.registerNotifications(far.user.id, 2);
    const r = await request(false, 2);
    await source.getRepository(TripRequest).update(r.id, {
      departureDateMin: new Date(Date.now() + 86_400_000), departureDateMax: new Date(Date.now() + 90_000_000),
    });
    await Promise.all([service.notifyScheduledRequest(r.id), service.notifyScheduledRequest(r.id)]);
    const rows = await source.query('SELECT * FROM notifications WHERE "eventKey" LIKE $1', [`nearby-scheduled-request:${r.id}:%`]);
    expect(rows).toHaveLength(2); expect(rows.map(row => row.userId).sort()).toEqual([near.user.id, far.user.id].sort());
    expect(rows[0].data).toMatchObject({ type: 'trip_request_nearby', ringAlert: 'nearby-request-v1' });
    expect(await offers(r.id)).toHaveLength(0);
    expect(await source.getRepository(TripRequest).findOneByOrFail({ id: r.id })).toMatchObject({ status: 'pending', selectedDriverId: null });
    expect((await service.status(near.user.id)).available).toBe(true);
  });

  it('does not ring a stale or out-of-radius position for a scheduled request', async () => {
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

  it('broadcasts to both drivers immediately and a decline does not withdraw the other offer', async () => {
    const near = await driver(); const far = await driver(15.32); const r = await request();
    await service.tick(); const invitations = await offers(r.id);
    expect(invitations).toHaveLength(2);
    const first = invitations.find(offer => offer.driverId === near.user.id);
    await service.respond(near.user.id, first.id, 'decline');
    expect((await offers(r.id)).find(offer => offer.driverId === far.user.id).status).toBe('pending');
    expect((await source.getRepository(TripRequest).findOneByOrFail({ id: r.id })).status).toBe('pending');
  });
  it('waits for the detached dispatch cycle after a response before allowing fixture cleanup', async () => {
    const d = await driver(), r = await request();
    await service.tick();
    await waitForDispatchCycles();
    const [offer] = await offers(r.id);
    let releaseAllocation!: () => void, allocationStarted!: () => void;
    const gate = new Promise<void>(resolve => { releaseAllocation = resolve; });
    const started = new Promise<void>(resolve => { allocationStarted = resolve; });
    const allocate = service['allocate'].bind(service);
    const allocation = jest.spyOn(service as any, 'allocate').mockImplementation(async (id: string) => {
      allocationStarted();
      await gate;
      return allocate(id);
    });
    let drained: Promise<void> | undefined;
    try {
      await expect(service.respond(d.user.id, offer.id, 'decline')).resolves.toMatchObject({ status: 'declined' });
      await started;
      // A second tick resolves immediately even though the original is still busy.
      await service.tick();
      expect(service['ticking']).toBe(true);
      let cleanupAllowed = false;
      drained = waitForDispatchCycles().then(() => { cleanupAllowed = true; });
      await Promise.resolve();
      expect(cleanupAllowed).toBe(false);
      releaseAllocation();
      await drained;
      expect(cleanupAllowed).toBe(true);
      expect(service['ticking']).toBe(false);
      expect(allocation).toHaveBeenCalledWith(r.id);
      expect((await offers(r.id))[0].status).toBe('declined');
    } finally {
      releaseAllocation();
      try { await drained; await waitForDispatchCycles(); }
      finally { allocation.mockRestore(); }
    }
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
  it('rejects stale automatic GPS instead of renewing a position while the app is asleep', async () => {
    const d = await driver();
    await expect(service.recordPosition(d.user.id, { latitude: -4.3, longitude: 15.31,
      accuracy: 20, recordedAt: new Date(Date.now() - 60000).toISOString() })).rejects.toThrow('trop ancienne');
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
  it('one expired offer cannot be accepted and does not invalidate another driver’s invitation', async () => {
    const near = await driver(); const far = await driver(15.32); const r = await request();
    await service.tick(); const first = (await offers(r.id)).find(o => o.driverId === near.user.id);
    await source.query('UPDATE trip_request_dispatch_offers SET "expiresAt" = now() - interval \'1 second\' WHERE id = $1', [first.id]);
    await expect(service.respond(near.user.id, first.id, 'accept')).rejects.toThrow('expiré');
    await service.tick();
    expect((await offers(r.id)).find(o => o.driverId === far.user.id).status).toBe('pending');
    expect((await offers(r.id)).find(o => o.driverId === near.user.id).status).toBe('expired');
  });
  it('a late heartbeat cannot reactivate a driver who went offline', async () => {
    const d = await driver(); const leaseId = d.presence.presence.leaseId;
    await service.setPresence(d.user.id, { available: false });
    await service.setPresence(d.user.id, { available: true, vehicleId: d.vehicle.id, seats: 4, latitude: -4.3, longitude: 15.31, leaseId });
    expect((await service.status(d.user.id)).available).toBe(false);
  });

  it('only one driver wins concurrent broadcast acceptance; all other offers are cancelled', async () => {
    const a = await driver(), b = await driver(15.32), r = await request();
    await Promise.all([service['allocate'](r.id), service['allocate'](r.id)]);
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

  it.each([true, false])('continues beyond a 50-driver batch without duplicate alerts (immediate=%s)', async immediate => {
    for (let i = 0; i < 52; i++) {
      const d = await driver(15.31 + i * 0.00001); await service.registerNotifications(d.user.id, 2);
    }
    const r = await request(immediate);
    const run = () => immediate ? service['allocate'](r.id) : service.notifyScheduledRequest(r.id);
    await run(); await run(); await run();
    if (immediate) expect(await offers(r.id)).toHaveLength(52);
    const notifications = await source.query(`SELECT * FROM notifications WHERE data ->> 'tripRequestId' = $1`, [r.id]);
    expect(notifications).toHaveLength(52);
    expect(new Set(notifications.map(n => n.userId)).size).toBe(52);
  }, 30000);

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
    await driver(); await driver(15.32); const r = await request(); await service['allocate'](r.id);
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
