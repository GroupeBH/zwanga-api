import { execFileSync } from 'node:child_process';
import { postgresTestServerOptions } from '../../../test/postgres-test-options';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { typeOrmEntities } from '../../database/entities';
import { AddDriverDispatch1780000048000 } from '../../database/migrations/1780000048000-AddDriverDispatch';
import { IndexNearbyRequestAlerts1780000066000 } from '../../database/migrations/1780000066000-IndexNearbyRequestAlerts';
import { DriverDispatchService } from './dispatch.service';
import { User, UserRole, UserStatus } from '../../users/entities/user.entity';
import { KycDocument, KycStatus } from '../../users/entities/kyc-document.entity';
import { Vehicle, VehicleType } from '../../vehicles/entities/vehicle.entity';
import { TripRequest } from '../entities/trip-request.entity';
import { DriverOffer } from '../entities/driver-offer.entity';
import { TripRequestsService } from '../trip-requests.service';
import { boundedInteger, dispatchOfferIsActionable } from './dispatch-policy';
import { NotificationService } from '../../notifications/notifications.service';
import { Notification } from '../../notifications/entities/notification.entity';

describe('dispatch policy', () => {
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
    execFileSync(executable('pg_ctl'), ['-D', directory, '-l', join(directory, 'postgres.log'), '-o', postgresTestServerOptions(port), '-w', 'start'], { windowsHide: true, stdio: 'ignore', timeout: 30000 });
    started = true;
    source = new DataSource({ type: 'postgres', host: '127.0.0.1', port, username: 'dispatch_test', database: 'postgres', entities: typeOrmEntities, synchronize: false });
    await source.initialize();
    await source.query('CREATE EXTENSION IF NOT EXISTS postgis');
    await source.synchronize();
    await source.query('ALTER TABLE trip_requests DROP COLUMN "immediateDispatch"');
    const runner = source.createQueryRunner();
    try { await new AddDriverDispatch1780000048000().up(runner); } finally { await runner.release(); }
    service = new DriverDispatchService(source, new ConfigService({ DRIVER_DISPATCH_ENABLED: 'true' }),
      { dispatchTransactionalNotifications: jest.fn().mockResolvedValue(undefined) } as never);
  }, 60000);
  beforeEach(async () => { await source.query('TRUNCATE users CASCADE'); });
  afterAll(async () => {
    try { if (source?.isInitialized) await source.destroy(); }
    finally {
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

  it('alerts the nearest compatible current v2 driver for tomorrow without assigning or blocking them', async () => {
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
    const rows = await source.query('SELECT * FROM notifications WHERE "eventKey" = $1', [`nearby-scheduled-request:${r.id}`]);
    expect(rows).toHaveLength(1); expect(rows[0].userId).toBe(near.user.id);
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
    expect(await source.query('SELECT id FROM notifications WHERE "eventKey" = $1', [`nearby-scheduled-request:${r.id}`])).toHaveLength(0);
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

  it('chooses the closest compatible driver, then the next after decline', async () => {
    const near = await driver(); const far = await driver(15.32); const r = await request();
    await service.tick(); const [first] = await offers(r.id);
    expect(first.driverId).toBe(near.user.id);
    await service.respond(near.user.id, first.id, 'decline');
    // respond starts a bounded cycle asynchronously; wait for its DB operations, not a fixed sleep.
    for (let i = 0; i < 30 && (await offers(r.id)).length < 2; i++) await new Promise(done => setTimeout(done, 10));
    expect((await offers(r.id))[1].driverId).toBe(far.user.id);
    expect((await source.getRepository(TripRequest).findOneByOrFail({ id: r.id })).status).toBe('pending');
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
  it('expired offer cannot be accepted, and the next driver receives a distinct offer', async () => {
    const near = await driver(); const far = await driver(15.32); const r = await request();
    await service.tick(); const [first] = await offers(r.id);
    await source.query('UPDATE trip_request_dispatch_offers SET "expiresAt" = now() - interval \'1 second\' WHERE id = $1', [first.id]);
    await expect(service.respond(near.user.id, first.id, 'accept')).rejects.toThrow('expiré');
    await service.tick(); expect((await offers(r.id))[1].driverId).toBe(far.user.id);
  });
  it('a late heartbeat cannot reactivate a driver who went offline', async () => {
    const d = await driver(); const leaseId = d.presence.presence.leaseId;
    await service.setPresence(d.user.id, { available: false });
    await service.setPresence(d.user.id, { available: true, vehicleId: d.vehicle.id, seats: 4, latitude: -4.3, longitude: 15.31, leaseId });
    expect((await service.status(d.user.id)).available).toBe(false);
  });
});
