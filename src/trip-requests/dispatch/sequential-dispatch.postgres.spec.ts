import { sequentialMobileFlow } from '../../../test/sequential-mobile-flow';
import { RequestResponsePhases1780000098000 } from '../../database/migrations/1780000098000-RequestResponsePhases';
import { claimRequestAcceptance, completeRequestAcceptance, releaseRequestAcceptance, startPassengerDecision } from './request-acceptance';
import { Booking, BookingStatus } from '../../bookings/entities/booking.entity';
import { DriverOffer, DriverOfferStatus } from '../entities/driver-offer.entity';
import { Test } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import supertest from 'supertest';
import { DriverDispatchController } from './dispatch.controller';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { createClient } from 'redis';
import { DataSource } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { postgresTestServerOptions } from '../../../test/postgres-test-options';
import { typeOrmEntities } from '../../database/entities';
import { AddDriverDispatch1780000048000 } from '../../database/migrations/1780000048000-AddDriverDispatch';
import { BroadcastDriverRequests1780000074000 } from '../../database/migrations/1780000074000-BroadcastDriverRequests';
import { RetainDriverLastLocation1780000076000 } from '../../database/migrations/1780000076000-RetainDriverLastLocation';
import { NearbyRequestRingingCooldown1780000087000 } from '../../database/migrations/1780000087000-NearbyRequestRingingCooldown';
import { DispatchDeliveryResilience1780000088000 } from '../../database/migrations/1780000088000-DispatchDeliveryResilience';
import { RememberDriverRequestRefusals1780000095000 } from '../../database/migrations/1780000095000-RememberDriverRequestRefusals';
import { SequentialRequestQueue1780000097000 } from '../../database/migrations/1780000097000-SequentialRequestQueue';
import { User, UserRole, UserStatus } from '../../users/entities/user.entity';
import { KycDocument, KycStatus } from '../../users/entities/kyc-document.entity';
import { Vehicle, VehicleType } from '../../vehicles/entities/vehicle.entity';
import { TripRequest, TripRequestStatus } from '../entities/trip-request.entity';
import { Trip } from '../../trips/entities/trip.entity';
import { saveRequestTrip } from '../../trips/save-request-trip';
import { Notification } from '../../notifications/entities/notification.entity';
import { RequestDriverQueue, REQUEST_DEADLINES_KEY } from './request-driver-queue';
import { SequentialDispatchService } from './sequential-dispatch.service';
import { DriverDispatchService } from './dispatch.service';
import { assertSequentialInvitation, sequentialInvitationSql } from './sequential-policy';

// No .env: brand-new PostgreSQL cluster and a dedicated loopback Redis port only.
const pgBin = process.env.DISPATCH_TEST_POSTGRES_BIN;
const redisPort = Number(process.env.DISPATCH_TEST_REDIS_PORT);
(pgBin && redisPort > 1024 && redisPort !== 6379 ? describe : describe.skip)('sequential relay with real PostgreSQL + Redis', () => {
  let directory: string, started = false, db: DataSource, redis: ReturnType<typeof createClient>;
  let queue: RequestDriverQueue, relay: SequentialDispatchService, dispatch: DriverDispatchService;
  const config = new ConfigService({ DRIVER_DISPATCH_ENABLED: 'true' });
  const notifications = { dispatchUrgentNotifications: jest.fn().mockResolvedValue(undefined),
    dispatchTransactionalNotifications: jest.fn().mockResolvedValue(undefined) };
  const changes = { enqueue: jest.fn() };
  const ids: string[] = [];
  const executable = (name: string) => join(pgBin!, process.platform === 'win32' ? name + '.exe' : name);
  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'zwanga-sequential-test-'));
    execFileSync(executable('initdb'), ['-D', directory, '-U', 'dispatch_test', '-A', 'trust', '--no-locale', '-E', 'UTF8'],
      { windowsHide: true, stdio: 'pipe', timeout: 30000 });
    const port = await new Promise<number>(done => {
      const server = createServer(); server.listen(0, '127.0.0.1', () => {
        const port = (server.address() as { port: number }).port; server.close(() => done(port));
      });
    });
    execFileSync(executable('pg_ctl'), ['-D', directory, '-l', join(directory, 'postgres.log'), '-o', postgresTestServerOptions(port), '-w', 'start'],
      { windowsHide: true, stdio: 'ignore', timeout: 30000 }); started = true;
    db = new DataSource({ type: 'postgres', host: '127.0.0.1', port, username: 'dispatch_test', database: 'postgres',
      entities: typeOrmEntities, synchronize: false });
    await db.initialize(); await db.query('CREATE EXTENSION IF NOT EXISTS postgis'); await db.synchronize();
    await db.query('ALTER TABLE trip_requests DROP COLUMN "immediateDispatch", DROP COLUMN "sequentialDispatch"');
    const runner = db.createQueryRunner();
    try {
      for (const migration of [new AddDriverDispatch1780000048000(), new BroadcastDriverRequests1780000074000(),
        new RetainDriverLastLocation1780000076000(), new NearbyRequestRingingCooldown1780000087000(),
        new RememberDriverRequestRefusals1780000095000(), new DispatchDeliveryResilience1780000088000(),
        new SequentialRequestQueue1780000097000(), new RequestResponsePhases1780000098000()]) await migration.up(runner);
    } finally { await runner.release(); }
    redis = createClient({ socket: { host: '127.0.0.1', port: redisPort, connectTimeout: 3000, reconnectStrategy: false } });
    redis.on('error', () => undefined); await redis.connect();
    queue = new RequestDriverQueue({ getClient: () => redis } as never);
    relay = new SequentialDispatchService(db, config, queue, notifications as never, changes as never);
    dispatch = new DriverDispatchService(db, config, notifications as never, changes as never, relay);
  }, 90000);
  beforeEach(async () => {
    await db.query('TRUNCATE users CASCADE'); jest.clearAllMocks();
  });
  afterEach(async () => { jest.restoreAllMocks(); for (const id of ids.splice(0)) await queue.close(id); });
  afterAll(async () => {
    try { if (redis?.isOpen) await redis.disconnect(); if (db?.isInitialized) await db.destroy(); }
    finally {
      if (started || (directory && existsSync(join(directory, 'postmaster.pid')))) execFileSync(executable('pg_ctl'), ['-D', directory, '-m', 'fast', '-w', 'stop'], { windowsHide: true, stdio: 'pipe', timeout: 30000 });
      if (directory && resolve(directory).startsWith(resolve(tmpdir()) + sep) && directory.includes('zwanga-sequential-test-'))
        rmSync(directory, { recursive: true, force: true });
    }
  });
  const driver = async (longitude = 15.31) => {
    const user = await db.getRepository(User).save({ firstName: 'Fixture', lastName: 'Driver', role: UserRole.DRIVER,
      status: UserStatus.ACTIVE, isDriver: true, fcmToken: 'fixture-' + randomUUID() });
    await db.getRepository(KycDocument).save({ userId: user.id, status: KycStatus.APPROVED });
    const vehicle = await db.getRepository(Vehicle).save({ ownerId: user.id, brand: 'Fixture', model: 'Fixture', color: 'Fixture',
      licensePlate: randomUUID(), type: VehicleType.CAR });
    await dispatch.setPresence(user.id, { available: true, vehicleId: vehicle.id, seats: 4, latitude: -4.3, longitude });
    return user;
  };
  const request = async (immediateDispatch = false, targetDriverId: string | null = null) => {
    const passenger = await db.getRepository(User).save({ firstName: 'Fixture', lastName: 'Passenger' });
    const result = await db.getRepository(TripRequest).save({ passengerId: passenger.id, immediateDispatch, sequentialDispatch: true,
      targetDriverId, departureLocation: 'Fixture departure', arrivalLocation: 'Fixture arrival',
      departurePoint: { type: 'Point', coordinates: [15.31, -4.3] }, arrivalPoint: { type: 'Point', coordinates: [15.32, -4.3] },
      departureDateMin: new Date(Date.now() + 1000), departureDateMax: new Date(Date.now() + 2400000),
      numberOfSeats: 1, maxPricePerSeat: 1000, vehicleType: VehicleType.CAR }); ids.push(result.id); return result;
  };
  const offers = (id: string) => db.query('SELECT * FROM trip_request_dispatch_offers WHERE "requestId" = $1 ORDER BY "createdAt", id', [id]);
  const notices = (id: string) => db.getRepository(Notification).createQueryBuilder('n').where("n.data ->> 'tripRequestId' = :id", { id }).getMany();
  const privateTrip = (r: TripRequest, driverId: string) => db.getRepository(Trip).create({ driverId, tripRequestId: r.id,
    isPrivate: true, departureLocation: r.departureLocation, arrivalLocation: r.arrivalLocation,
    departureDate: r.departureDateMin, totalSeats: 4, availableSeats: 4, pricePerSeat: 1000 });
  it.each([false, true])('invites only the nearest, keeps the other IDs in Redis, and never duplicates a concurrent tick (%s)', async immediate => {
    const first = await driver(); await driver(15.311); await driver(15.312); const r = await request(immediate);
    expect(await relay.advance(r.id)).toBe(true);
    const [offer] = await offers(r.id); expect(offer.driverId).toBe(first.id);
    expect(offer.expiresAt.getTime() - offer.createdAt.getTime()).toBeGreaterThanOrEqual(39_000);
    expect(offer.expiresAt.getTime() - offer.createdAt.getTime()).toBeLessThanOrEqual(41_000);
    expect(await redis.lLen('ride-requests:{' + r.id + '}:waiting')).toBe(2);
    const secondWorker = new SequentialDispatchService(db, config, queue, notifications as never, changes as never);
    await Promise.all([relay.advance(r.id), secondWorker.advance(r.id), dispatch.tick()]);
    expect(await offers(r.id)).toHaveLength(1); expect(await notices(r.id)).toHaveLength(1);
    expect((await notices(r.id))[0].data?.type).toBe(immediate ? 'driver_dispatch_offer' : 'trip_request_nearby');
  });
  it('authenticated refusal advances immediately; replay and a forged event cannot skip the next driver', async () => {
    const first = await driver(), second = await driver(15.311); await driver(15.312); const r = await request();
    await relay.advance(r.id); const [offer] = await offers(r.id);
    await expect(dispatch.receiveRequestEvent(second.id, r.id, offer.id)).rejects.toThrow();
    await dispatch.receiveRequestEvent(first.id, r.id, offer.id);
    await dispatch.receiveRequestEvent(first.id, r.id, offer.id);
    const rows = await offers(r.id); expect(rows).toHaveLength(2);
    expect(rows[0].status).toBe('declined'); expect(rows[1].driverId).toBe(second.id);
    expect((await notices(r.id)).filter(n => n.isActive)).toHaveLength(1);
  });
  it('recovers a missing Redis deadline after 40 seconds and rejects the former recipient', async () => {
    const first = await driver(), second = await driver(15.311), r = await request();
    await relay.advance(r.id);
    await db.query(`UPDATE trip_request_dispatch_offers SET "expiresAt" = now() - interval '1 second' WHERE "requestId" = $1`, [r.id]);
    await redis.zRem(REQUEST_DEADLINES_KEY, r.id); await redis.del('ride-requests:{' + r.id + '}:waiting');
    await relay.deadlines(); const rows = await offers(r.id);
    expect(rows).toHaveLength(2); expect(rows[0].status).toBe('expired'); expect(rows[1].driverId).toBe(second.id);
    await expect(assertSequentialInvitation(db.manager, r, first.id)).rejects.toThrow();
    await expect(assertSequentialInvitation(db.manager, r, second.id)).resolves.toBeUndefined();
  });
  it('acceptance stops the queue and hides the request from every other driver', async () => {
    const first = await driver(), second = await driver(15.311), r = await request(true);
    await relay.advance(r.id); const [offer] = await offers(r.id);
    await Promise.all([dispatch.respond(first.id, offer.id, 'accept'), dispatch.respond(first.id, offer.id, 'accept')]);
    await expect(dispatch.respond(second.id, offer.id, 'accept')).rejects.toThrow();
    await relay.advance(r.id); await relay.deadlines();
    expect((await offers(r.id)).map(x => x.status)).toEqual(['accepted']);
    expect(await redis.zScore(REQUEST_DEADLINES_KEY, r.id)).toBeNull();
    expect(await redis.exists('ride-requests:{' + r.id + '}:waiting')).toBe(0);
    const visible = await db.query('SELECT r.id FROM trip_requests r WHERE r.id=$1 AND ' + sequentialInvitationSql('r.id', '$2'), [r.id, second.id]);
    expect(visible).toHaveLength(0);
    expect((await db.getRepository(TripRequest).findOneByOrFail({ id: r.id })).selectedDriverId).toBe(first.id);
    expect((await notices(r.id)).filter(n => n.data?.type === 'trip_request_accepted')).toHaveLength(1);
  });
  it('a Redis outage does not broadcast, and the next recovery attempt delivers once', async () => {
    await driver(); await driver(15.311); const r = await request();
    const fail = jest.spyOn(queue, 'lock').mockRejectedValue(new Error('offline'));
    expect(await relay.advance(r.id)).toBe(false); expect(await offers(r.id)).toHaveLength(0);
    fail.mockRestore(); expect(await relay.advance(r.id)).toBe(true); expect(await notices(r.id)).toHaveLength(1);
  });
  it('does not silently broaden a targeted request after its chosen driver refuses', async () => {
    const chosen = await driver(); await driver(15.311); const r = await request(false, chosen.id);
    await relay.advance(r.id); await dispatch.declineNearbyRequest(chosen.id, r.id); await relay.advance(r.id);
    expect((await offers(r.id)).map(x => x.status)).toEqual(['declined']); expect(await notices(r.id)).toHaveLength(1);
  });
  it('a popped Redis entry is reconstructed after an outbox transaction rollback', async () => {
    const first = await driver(); await driver(15.311); const r = await request();
    await db.query(`CREATE FUNCTION reject_test_notice() RETURNS trigger LANGUAGE plpgsql AS $body$ BEGIN RAISE EXCEPTION 'synthetic outbox failure'; END; $body$`);
    await db.query('CREATE TRIGGER reject_test_notice BEFORE INSERT ON notifications FOR EACH ROW EXECUTE FUNCTION reject_test_notice()');
    try {
      expect(await relay.advance(r.id)).toBe(false); expect(await offers(r.id)).toHaveLength(0);
      expect(await notices(r.id)).toHaveLength(0);
    } finally { await db.query('DROP TRIGGER reject_test_notice ON notifications'); await db.query('DROP FUNCTION reject_test_notice()'); }
    expect(await relay.advance(r.id)).toBe(true);
    expect((await offers(r.id))[0].driverId).toBe(first.id);
    expect(await notices(r.id)).toHaveLength(1);
  });
  it('an old worker cannot bypass the one-pending-request constraint during rollout', async () => {
    await driver(); const second = await driver(15.311), r = await request(); await relay.advance(r.id);
    const vehicle = await db.getRepository(Vehicle).findOneByOrFail({ ownerId: second.id });
    await expect(db.query(`INSERT INTO trip_request_dispatch_offers
      (id,"requestId","driverId","vehicleId",seats,"expiresAt",sequential)
      VALUES ($1,$2,$3,$4,4,now() + interval '60 seconds',false)`,
      [randomUUID(),r.id,second.id,vehicle.id])).rejects.toMatchObject({ code: '23505' });
    expect(await offers(r.id)).toHaveLength(1);
  });
  it('a stale Redis lease cannot delete or consume the new worker queue', async () => {
    const r = await request(), old = await queue.lock(r.id);
    await redis.set('ride-requests:{' + r.id + '}:lock', 'replacement', { PX: 10000 });
    expect(await queue.replace(r.id, old!, ['first'], 60)).toBe(false);
    expect(await queue.take(r.id, old!)).toBeNull(); await queue.unlock(r.id, old!);
    expect(await redis.get('ride-requests:{' + r.id + '}:lock')).toBe('replacement');
    await queue.unlock(r.id, 'replacement');
  });
  it('scheduled acceptance is fenced under the trip-creation lock and stops relay while booking commits', async () => {
    const first = await driver(), second = await driver(15.311), r = await request(); await relay.advance(r.id);
    const repository = db.getRepository(Trip);
    const trip = (driverId: string) => repository.create({ driverId, tripRequestId: r.id, isPrivate: true,
      departureLocation: r.departureLocation, arrivalLocation: r.arrivalLocation,
      departureDate: r.departureDateMin, totalSeats: 4, availableSeats: 4, pricePerSeat: 1000 });
    await expect(saveRequestTrip(repository, trip(second.id), r)).rejects.toThrow();
    const winner = await saveRequestTrip(repository, trip(first.id), r);
    await db.query(`UPDATE trip_request_dispatch_offers SET "expiresAt"=now()-interval '1 second' WHERE "requestId"=$1`, [r.id]);
    await relay.deadlines(); expect(await offers(r.id)).toHaveLength(1);
    await db.getRepository(TripRequest).update(r.id, { selectedDriverId: first.id, status: TripRequestStatus.DRIVER_SELECTED, tripId: winner.id });
    await relay.advance(r.id); expect(await redis.zScore(REQUEST_DEADLINES_KEY, r.id)).toBeNull();
  });
  it('HTTP callback validates identity, role, payload, ownership and duplicate delivery', async () => {
    const first = await driver(), second = await driver(15.311), r = await request();
    await relay.advance(r.id); const [offer] = await offers(r.id);
    const module = await Test.createTestingModule({ controllers: [DriverDispatchController],
      providers: [{ provide: DriverDispatchService, useValue: dispatch }] })
      .overrideGuard(JwtAuthGuard).useValue({ canActivate: (context: any) => {
        const req = context.switchToHttp().getRequest();
        if (!req.headers['x-fixture-driver']) return false;
        req.user = { userId: req.headers['x-fixture-driver'], role: req.headers['x-fixture-role'] ?? 'driver' }; return true;
      } }).compile();
    const app = module.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    // Production authenticates globally before applying RolesGuard as well.
    app.useGlobalGuards({ canActivate: (context: any) => {
      const req = context.switchToHttp().getRequest();
      if (!req.headers['x-fixture-driver']) return false;
      req.user = { userId: req.headers['x-fixture-driver'], role: req.headers['x-fixture-role'] ?? 'driver' }; return true;
    } }, new RolesGuard(module.get(Reflector)));
    try {
      await app.init(); const url = '/driver-dispatch/requests/' + r.id + '/events';
      const post = () => supertest(app.getHttpServer()).post(url);
      await post().send({ type: 'declined', offerId: offer.id }).expect(403);
      await post().set('x-fixture-driver', first.id).set('x-fixture-role', 'passenger').send({ type: 'declined', offerId: offer.id }).expect(403);
      await post().set('x-fixture-driver', first.id).send({ type: 'timeout', offerId: offer.id }).expect(400);
      await post().set('x-fixture-driver', second.id).send({ type: 'declined', offerId: offer.id }).expect(404);
      for (let i = 0; i < 2; i++) await post().set('x-fixture-driver', first.id).send({ type: 'declined', offerId: offer.id }).expect(201);
      expect((await offers(r.id)).map(o => o.status)).toEqual(['declined','pending']);
    } finally { await app.close(); }
  });
  it('an invitation to a different request cannot grant read access', async () => {
    const first = await driver(), second = await driver(15.311);
    const a = await request(false, first.id), b = await request(false, second.id);
    await relay.advance(a.id); await relay.advance(b.id);
    const query = 'SELECT r.id FROM trip_requests r WHERE r.id=$1 AND ' + sequentialInvitationSql('r.id', '$2');
    expect(await db.query(query, [a.id, second.id])).toHaveLength(0);
    expect(await db.query(query, [b.id, second.id])).toHaveLength(1);
  });
  it('cancellation discards Redis work and deactivates the old notification', async () => {
    await driver(); await driver(15.311); const r = await request(); await relay.advance(r.id);
    await db.getRepository(TripRequest).update(r.id, { status: TripRequestStatus.CANCELLED });
    await relay.advance(r.id);
    expect((await offers(r.id)).map(x => x.status)).toEqual(['cancelled']);
    expect((await notices(r.id)).filter(n => n.isActive)).toHaveLength(0);
    expect(await redis.zScore(REQUEST_DEADLINES_KEY, r.id)).toBeNull();
  });
  it('SQL deadline recovery still runs when the Redis deadline read fails', async () => {
    await driver(); const second = await driver(15.311), r = await request(); await relay.advance(r.id);
    await db.query(`UPDATE trip_request_dispatch_offers SET "expiresAt"=now()-interval '1 second' WHERE "requestId"=$1`, [r.id]);
    jest.spyOn(queue, 'due').mockRejectedValue(new Error('Operation deadline exceeded'));
    await relay.deadlines(); expect((await offers(r.id))[1].driverId).toBe(second.id);
    await relay.deadlines(); expect(await offers(r.id)).toHaveLength(2);
  });
  it('a response reserves slow acceptance exclusively before route preparation', async () => {
    const first = await driver(), r = await request(); await driver(15.311); await relay.advance(r.id);
    const token = await claimRequestAcceptance(db.manager, r, first.id);
    await expect(claimRequestAcceptance(db.manager, r, first.id)).rejects.toThrow();
    const [invitation] = await offers(r.id);
    expect(invitation.phase).toBe('accepting'); expect(invitation.expiresAt.getTime()-Date.now()).toBeGreaterThan(100000);
    expect((await notices(r.id)).filter(n => n.isActive)).toHaveLength(0);
    await expect(saveRequestTrip(db.getRepository(Trip), privateTrip(r, first.id), r, randomUUID())).rejects.toThrow();
    const trip = await saveRequestTrip(db.getRepository(Trip), privateTrip(r, first.id), r, token);
    await relay.advance(r.id); expect(await offers(r.id)).toHaveLength(1); expect(trip.tripRequestId).toBe(r.id);
  });
  it.each([false, true])('recovers an abandoned empty provisional trip without blocking the next driver (%s)', async claimed => {
    const first = await driver(), second = await driver(15.311), r = await request(); await relay.advance(r.id);
    const token = claimed ? await claimRequestAcceptance(db.manager, r, first.id) : undefined;
    const trip = await saveRequestTrip(db.getRepository(Trip), privateTrip(r, first.id), r, token);
    await db.query(`UPDATE trips SET "createdAt"=now()-interval '5 minutes' WHERE id=$1`, [trip.id]);
    await db.query(`UPDATE trip_request_dispatch_offers SET "expiresAt"=now()-interval '5 minutes' WHERE "requestId"=$1`, [r.id]);
    await relay.deadlines();
    expect((await db.getRepository(Trip).findOneByOrFail({ id: trip.id })).status).toBe('cancelled');
    expect((await offers(r.id)).map(o => o.status)).toEqual(['expired','pending']);
    expect((await offers(r.id))[1].driverId).toBe(second.id);
    if (token) await expect(saveRequestTrip(db.getRepository(Trip), privateTrip(r, first.id), r, token)).rejects.toThrow();
  });
  it('failed preparation releases only its own claim, and requeues immediately', async () => {
    const first = await driver(), second = await driver(15.311), r = await request(); await relay.advance(r.id);
    const token = await claimRequestAcceptance(db.manager, r, first.id);
    await releaseRequestAcceptance(db.manager, r.id, first.id, randomUUID());
    expect((await offers(r.id))[0].expiresAt.getTime()).toBeGreaterThan(Date.now());
    await releaseRequestAcceptance(db.manager, r.id, first.id, token); await relay.advance(r.id);
    expect((await offers(r.id))[1].driverId).toBe(second.id);
  });
  it('recovers a committed booking once instead of giving its request to another driver', async () => {
    const first = await driver(), r = await request(); await driver(15.311); await relay.advance(r.id);
    const trip = await saveRequestTrip(db.getRepository(Trip), privateTrip(r, first.id), r);
    await db.getRepository(Booking).save({ tripId: trip.id, passengerId: r.passengerId, status: BookingStatus.ACCEPTED });
    await db.query(`UPDATE trip_request_dispatch_offers SET "expiresAt"=now()-interval '1 second' WHERE "requestId"=$1`, [r.id]);
    await relay.deadlines(); await relay.advance(r.id);
    const current = await db.getRepository(TripRequest).findOneByOrFail({ id: r.id });
    expect(current.tripId).toBe(trip.id); expect(current.selectedDriverId).toBe(first.id);
    expect((await offers(r.id)).map(o => o.status)).toEqual(['accepted']);
    expect((await notices(r.id)).filter(n => n.data?.type === 'trip_request_accepted')).toHaveLength(1);
  });
  it('booking and selection roll back together if confirmation cannot complete', async () => {
    const first = await driver(), r = await request(); await relay.advance(r.id);
    const token = await claimRequestAcceptance(db.manager, r, first.id);
    const trip = await saveRequestTrip(db.getRepository(Trip), privateTrip(r, first.id), r, token);
    await expect(db.transaction(async manager => {
      await manager.save(Booking, { tripId: trip.id, passengerId: r.passengerId, status: BookingStatus.ACCEPTED });
      await completeRequestAcceptance(manager, r, trip);
      throw new Error('forced rollback');
    })).rejects.toThrow('forced rollback');
    expect(await db.getRepository(Booking).count()).toBe(0);
    expect((await db.getRepository(TripRequest).findOneByOrFail({ id: r.id })).selectedDriverId).toBeNull();
    expect((await notices(r.id)).filter(n => n.data?.type === 'trip_request_accepted')).toHaveLength(0);
  });
  it('counteroffers have a separate passenger window, then retire visibly before relay', async () => {
    const first = await driver(), second = await driver(15.311), r = await request(); await relay.advance(r.id);
    const [invitation] = await offers(r.id);
    const alternative = await db.transaction(async manager => {
      const current = await manager.findOneOrFail(TripRequest, { where: { id: r.id }, lock: { mode: 'pessimistic_write' } });
      await startPassengerDecision(manager, current, first.id);
      await manager.update(TripRequest, r.id, { status: TripRequestStatus.OFFERS_RECEIVED });
      return manager.save(DriverOffer, { tripRequestId: r.id, driverId: first.id, vehicleId: invitation.vehicleId,
        pricePerSeat: 1200, proposedDepartureDate: r.departureDateMin, availableSeats: 4 });
    });
    await relay.advance(r.id); expect(await offers(r.id)).toHaveLength(1);
    expect((await offers(r.id))[0].expiresAt.getTime()-Date.now()).toBeGreaterThan(100000);
    await expect(assertSequentialInvitation(db.manager, r, first.id, ['passenger'])).resolves.toBeUndefined();
    await expect(assertSequentialInvitation(db.manager, r, first.id)).rejects.toThrow();
    await expect(dispatch.respond(first.id, invitation.id, 'accept')).rejects.toThrow();
    await db.query(`UPDATE trip_request_dispatch_offers SET "expiresAt"=now()-interval '1 second' WHERE "requestId"=$1`, [r.id]);
    await relay.deadlines(); expect((await offers(r.id))[1].driverId).toBe(second.id);
    expect((await db.getRepository(DriverOffer).findOneByOrFail({ id: alternative.id })).status).toBe(DriverOfferStatus.CANCELLED);
    await expect(assertSequentialInvitation(db.manager, r, first.id, ['passenger'])).rejects.toThrow();
  });
  it('passenger cancellation cleans an empty provisional trip without reopening the request', async () => {
    const first = await driver(), r = await request(); await driver(15.311); await relay.advance(r.id);
    const token = await claimRequestAcceptance(db.manager, r, first.id);
    const trip = await saveRequestTrip(db.getRepository(Trip), privateTrip(r, first.id), r, token);
    await db.getRepository(TripRequest).update(r.id, { status: TripRequestStatus.CANCELLED });
    await relay.advance(r.id);
    expect((await db.getRepository(Trip).findOneByOrFail({ id: trip.id })).status).toBe('cancelled');
    expect((await offers(r.id)).map(o => o.status)).toEqual(['cancelled']);
  });
  sequentialMobileFlow(() => ({ db, relay, dispatch, notifications, driver, ids, offers }));
});
