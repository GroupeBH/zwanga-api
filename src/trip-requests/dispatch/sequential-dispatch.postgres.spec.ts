import { sequentialMobileFlow } from '../../../test/sequential-mobile-flow';
import { availableRequestFlow } from '../../../test/available-request-flow';
import { SeparateRequestAttentionLease1780000101000 } from '../../database/migrations/1780000101000-SeparateRequestAttentionLease';
import { seedDispatchNotificationHistory } from '../../../test/notification-history';
import { IndexRequestNotificationRetirement1780000099000 } from '../../database/migrations/1780000099000-IndexRequestNotificationRetirement';
import { retireRequestInvitations, RETIRE_COUNTEROFFER_NOTIFICATIONS_SQL, RETIRE_REQUEST_NOTIFICATIONS_SQL } from './retire-request-invitations';
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
import { NotificationService } from '../../notifications/notifications.service';
import { RequestDriverQueue, REQUEST_DEADLINES_KEY } from './request-driver-queue';
import { SequentialDispatchService } from './sequential-dispatch.service';
import { DriverDispatchService } from './dispatch.service';
import { assertSequentialInvitation, sequentialInvitationSql } from './sequential-policy';
import { SharedTripOffersService } from '../shared-trip-offers.service';
import { BookingsService } from '../../bookings/bookings.service';
import { TripStatus } from '../../trips/entities/trip.entity';

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
      entities: typeOrmEntities, synchronize: false, extra: { options: '-c timezone=UTC' } });
    await db.initialize(); await db.query('CREATE EXTENSION IF NOT EXISTS postgis'); await db.synchronize();
    await db.query('ALTER TABLE trip_requests DROP COLUMN "immediateDispatch", DROP COLUMN "sequentialDispatch"');
    const runner = db.createQueryRunner();
    try {
      for (const migration of [new AddDriverDispatch1780000048000(), new BroadcastDriverRequests1780000074000(),
        new RetainDriverLastLocation1780000076000(), new NearbyRequestRingingCooldown1780000087000(),
        new RememberDriverRequestRefusals1780000095000(), new DispatchDeliveryResilience1780000088000(),
        new SequentialRequestQueue1780000097000(), new RequestResponsePhases1780000098000(),
        new IndexRequestNotificationRetirement1780000099000(), new SeparateRequestAttentionLease1780000101000()]) await migration.up(runner);
    } finally { await runner.release(); }
    redis = createClient({ socket: { host: '127.0.0.1', port: redisPort, connectTimeout: 3000, reconnectStrategy: false },
      password: process.env.DISPATCH_TEST_REDIS_PASSWORD });
    redis.on('error', () => undefined); await redis.connect();
    queue = new RequestDriverQueue({ getClient: () => redis } as never);
    relay = new SequentialDispatchService(db, config, queue, notifications as never, changes as never);
    dispatch = new DriverDispatchService(db, config, notifications as never, changes as never, relay);
  }, 90000);
  beforeEach(async () => {
    await db.query('TRUNCATE users CASCADE'); jest.clearAllMocks();
    relay = new SequentialDispatchService(db, config, queue, notifications as never, changes as never);
    dispatch = new DriverDispatchService(db, config, notifications as never, changes as never, relay);
  }, 30000); // TRUNCATE cascades through the disposable schema; allow slow Windows test disks.
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
  availableRequestFlow(() => ({ db, relay, dispatch, driver, request, offers }));
  const sharedFixture = async (immediate = false) => {
    const first = await driver(), second = await driver(15.311), r = await request(immediate);
    const vehicle = await db.getRepository(Vehicle).findOneByOrFail({ ownerId: first.id });
    const trip = await db.getRepository(Trip).save({ driverId: first.id, vehicleId: vehicle.id,
      departureLocation: 'A', arrivalLocation: 'B', departureDate: new Date(), status: TripStatus.ACTIVE,
      totalSeats: 2, availableSeats: 2, pricePerSeat: 1000, currentLocation: r.departurePoint });
    const bookings = Object.assign(Object.create(BookingsService.prototype), {
      bookingRepository: db.getRepository(Booking), tripRepository: db.getRepository(Trip),
      userRepository: db.getRepository(User), dataSource: db,
      configService: new ConfigService({ FIRST_TRIP_SUBSIDY_ENABLED: 'false', TRIP_PAYMENT_CURRENCY: 'CDF' }),
      MAX_SEATS_WITHOUT_APPROVED_KYC: 2, logger: { log: jest.fn(), warn: jest.fn(), debug: jest.fn() },
      cacheService: { del: jest.fn().mockResolvedValue(undefined) }, walletService: { convertPointsToMoney: () => 10 },
    });
    const shared = new SharedTripOffersService(db, bookings, relay, notifications as never, changes as never);
    return { first, second, r, trip, vehicle, shared };
  };
  it.each([false, true])('shared driver rings first but passenger consent is required, with a separate decision deadline (%s)', async immediate => {
    const { first, r, trip, shared } = await sharedFixture(immediate);
    // Ongoing-trip GPS also works without a discovery row.
    await db.query('DELETE FROM driver_dispatch_presence WHERE "driverId"=$1', [first.id]);
    expect(await relay.advance(r.id)).toBe(true);
    expect((await notices(r.id))[0].data).toMatchObject({ type: 'trip_request_nearby', sharedTrip: true, existingTripId: trip.id });
    expect((await offers(r.id))[0].driverId).toBe(first.id);
    const proposed = await shared.propose(first.id, r.id, trip.id);
    const [pending] = await offers(r.id);
    expect(pending.phase).toBe('passenger');
    if (immediate) await expect(dispatch.respond(first.id, pending.id, 'accept'))
      .rejects.toMatchObject({ response: { code: 'REQUEST_INVITATION_EXPIRED' } });
    expect(pending.expiresAt.getTime() - Date.now()).toBeGreaterThan(110_000);
    const again = await shared.propose(first.id, r.id, trip.id);
    expect(again.offerId).toBe(proposed.offerId);
    expect((await offers(r.id))[0].expiresAt).toEqual(pending.expiresAt);
    await expect(shared.accept(r.passengerId, r.id, proposed.offerId, false)).rejects.toMatchObject({ response: { code: 'SHARED_TRIP_CONSENT_REQUIRED' } });
    expect(await db.getRepository(Booking).count()).toBe(0);
    expect(await relay.advance(r.id)).toBe(false);
    const accepted = await shared.accept(r.passengerId, r.id, proposed.offerId, true);
    expect(accepted.tripId).toBe(trip.id);
    expect(await db.getRepository(Booking).count()).toBe(1);
    expect((await db.getRepository(Trip).findOneByOrFail({ id: trip.id })).availableSeats).toBe(1);
    expect((await offers(r.id)).map(o => o.status)).toEqual(['accepted']);
    expect(await shared.accept(r.passengerId, r.id, proposed.offerId, true)).toEqual(accepted);
    expect(await redis.zScore(REQUEST_DEADLINES_KEY, r.id)).toBeNull();
  });
  it.each(['decline', 'timeout'])('relays to the next driver when passenger sharing consent ends (%s)', async outcome => {
    const { first, second, r, trip, shared } = await sharedFixture();
    await relay.advance(r.id); const proposed = await shared.propose(first.id, r.id, trip.id);
    if (outcome === 'decline') await shared.decline(r.passengerId, r.id, proposed.offerId);
    else {
      await db.query(`UPDATE trip_request_dispatch_offers SET "expiresAt"=now()-interval '1 second' WHERE "requestId"=$1`, [r.id]);
      await relay.deadlines();
    }
    const rows = await offers(r.id);
    expect(rows).toHaveLength(2); expect(rows[1]).toMatchObject({ status: 'pending', driverId: second.id });
    expect(await db.getRepository(Booking).count()).toBe(0);
    await expect(shared.accept(r.passengerId, r.id, proposed.offerId, true)).rejects.toThrow();
  });
  it.each(['full', 'far', 'offline', 'wrong-vehicle', 'price', 'scheduled-later'])('skips an incompatible shared driver (%s)', async reason => {
    const { first, second, r, trip, vehicle } = await sharedFixture();
    if (reason === 'full') await db.getRepository(Trip).update(trip.id, { availableSeats: 0 });
    if (reason === 'far') await db.getRepository(Trip).update(trip.id, {
      currentLocation: { type: 'Point', coordinates: [16.3, -4.3] }, lastLocationUpdateAt: new Date(),
    });
    if (reason === 'offline') await db.query('UPDATE driver_dispatch_presence SET "discoveryEnabled"=false WHERE "driverId"=$1', [first.id]);
    if (reason === 'wrong-vehicle') await db.getRepository(Vehicle).update(vehicle.id, { type: VehicleType.MOTORCYCLE_TWO_WHEELS });
    if (reason === 'price') await db.getRepository(Trip).update(trip.id, { pricePerSeat: 2000 });
    if (reason === 'scheduled-later') await db.getRepository(TripRequest).update(r.id, { departureDateMin: new Date(Date.now() + 30 * 60_000) });
    expect(await relay.advance(r.id)).toBe(true);
    expect((await offers(r.id))[0].driverId).toBe(second.id);
  });
  it.each([false, true])('keeps Redis candidate order and never duplicates a concurrent tick (%s)', async immediate => {
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
  it('a post-commit Redis outage does not lose push; SQL expires safely and Redis resumes the queue', async () => {
    await driver(); await driver(15.311); const r = await request();
    jest.spyOn(queue, 'schedule').mockRejectedValue(new Error('offline'));
    jest.spyOn(queue, 'due').mockRejectedValue(new Error('offline'));
    expect(await relay.advance(r.id)).toBe(true);
    expect(await relay.advance(r.id)).toBe(false);
    expect(await offers(r.id)).toHaveLength(1); expect(await notices(r.id)).toHaveLength(1);
    expect(notifications.dispatchUrgentNotifications).toHaveBeenCalledTimes(1);
    await db.query(`UPDATE trip_request_dispatch_offers SET "expiresAt"=now()-interval '1 second' WHERE "requestId"=$1`, [r.id]);
    await relay.deadlines();
    expect((await offers(r.id)).map(o => o.status)).toEqual(['expired']);
    expect(notifications.dispatchUrgentNotifications).toHaveBeenCalledTimes(1);
    jest.restoreAllMocks();
    relay = new SequentialDispatchService(db, config, queue, notifications as never, changes as never);
    expect(await relay.advance(r.id)).toBe(true);
    expect((await offers(r.id)).map(o => o.status)).toEqual(['expired', 'pending']);
    expect(notifications.dispatchUrgentNotifications).toHaveBeenCalledTimes(2);
  });
  it('does not bypass Redis with a SQL-only selection while the queue is unavailable', async () => {
    await driver(); const r = await request();
    jest.spyOn(queue, 'claim').mockRejectedValue(new Error('queue offline'));
    expect(await relay.advance(r.id)).toBe(false);
    expect(await offers(r.id)).toHaveLength(0);
    expect(notifications.dispatchUrgentNotifications).not.toHaveBeenCalled();
  });
  it('refusal consumes the next cached Redis candidate without rebuilding the list', async () => {
    const first = await driver(), second = await driver(15.311); await driver(15.312);
    const r = await request(), seed = jest.spyOn(queue, 'seed');
    await relay.advance(r.id);
    const [initial] = await offers(r.id);
    await dispatch.receiveRequestEvent(first.id, r.id, initial.id);
    expect(seed).toHaveBeenCalledTimes(1);
    expect((await offers(r.id))[1].driverId).toBe(second.id);
    expect(await redis.lLen('ride-requests:{' + r.id + '}:waiting')).toBe(1);
  });
  it('rebuilds a cached queue after the passenger changes its target', async () => {
    const first = await driver(); await driver(15.311); const chosen = await driver(15.312);
    const r = await request(), seed = jest.spyOn(queue, 'seed');
    await relay.advance(r.id);
    await db.getRepository(TripRequest).update(r.id, { targetDriverId: chosen.id });
    await db.query(`UPDATE trip_request_dispatch_offers SET status='declined' WHERE "requestId"=$1`, [r.id]);
    await relay.advance(r.id);
    expect(seed).toHaveBeenCalledTimes(2);
    expect((await offers(r.id)).map(o => o.driverId)).toEqual([first.id, chosen.id]);
  });
  it('starts the push after commit and before a slow Redis schedule finishes', async () => {
    await driver(); const r = await request();
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const schedule = jest.spyOn(queue, 'schedule').mockImplementation(async () => {
      expect(notifications.dispatchUrgentNotifications).toHaveBeenCalledTimes(1);
      expect(await offers(r.id)).toHaveLength(1);
      await pending;
    });
    const job = relay.advance(r.id);
    try {
      for (let n = 0; n < 100 && !schedule.mock.calls.length; n++) await new Promise(resolve => setTimeout(resolve, 10));
      expect(schedule).toHaveBeenCalledTimes(1);
      expect(notifications.dispatchUrgentNotifications).toHaveBeenCalledTimes(1);
    } finally { release(); await job; }
  });
  it('concurrent different requests reserve distinct drivers without duplicate pending invitations', async () => {
    for (let n = 0; n < 8; n++) await driver(15.31 + n * 0.0001);
    const requests = await Promise.all(Array.from({ length: 8 }, () => request()));
    const outcomes = await Promise.allSettled(requests.map(r => relay.advance(r.id)));
    expect(outcomes.every(r => r.status === 'fulfilled' && r.value)).toBe(true);
    const rows = await db.query(`SELECT "driverId","requestId" FROM trip_request_dispatch_offers WHERE status='pending'`);
    expect(rows).toHaveLength(8);
    expect(new Set(rows.map(r => r.driverId)).size).toBe(8);
    expect(new Set(rows.map(r => r.requestId)).size).toBe(8);
  });
  it('does not silently broaden a targeted request after its chosen driver refuses', async () => {
    const chosen = await driver(); await driver(15.311); const r = await request(false, chosen.id);
    await relay.advance(r.id); await dispatch.declineNearbyRequest(chosen.id, r.id); await relay.advance(r.id);
    expect((await offers(r.id)).map(x => x.status)).toEqual(['declined']); expect(await notices(r.id)).toHaveLength(1);
  });
  it('an outbox failure rolls back the SQL invitation and the retry selects the same driver', async () => {
    const first = await driver(); await driver(15.311); const r = await request();
    const seed = jest.spyOn(queue, 'seed');
    await db.query(`CREATE FUNCTION reject_test_notice() RETURNS trigger LANGUAGE plpgsql AS $body$ BEGIN RAISE EXCEPTION 'synthetic outbox failure'; END; $body$`);
    await db.query('CREATE TRIGGER reject_test_notice BEFORE INSERT ON notifications FOR EACH ROW EXECUTE FUNCTION reject_test_notice()');
    try {
      expect(await relay.advance(r.id)).toBe(false); expect(await offers(r.id)).toHaveLength(0);
      expect(await notices(r.id)).toHaveLength(0);
    } finally { await db.query('DROP TRIGGER reject_test_notice ON notifications'); await db.query('DROP FUNCTION reject_test_notice()'); }
    expect(await relay.advance(r.id)).toBe(true);
    expect((await offers(r.id))[0].driverId).toBe(first.id);
    expect(await notices(r.id)).toHaveLength(1);
    expect(seed).toHaveBeenCalledTimes(1);
  });
  it('an expired Redis lease cannot acknowledge or reset a replacement worker queue', async () => {
    const r = await request(), first = randomUUID(), second = randomUUID();
    const claim = await queue.claim(r.id, 'fixture-version');
    expect(claim).not.toBeNull();
    expect(await queue.seed(r.id, claim!.token, 'fixture-version', [first, second])).toBe(true);
    await redis.set('ride-requests:{' + r.id + '}:lock', 'replacement', { PX: 10000 });
    expect(await queue.seed(r.id, claim!.token, 'stale-version', [randomUUID()])).toBe(false);
    await queue.release(r.id, claim!.token, first, true);
    expect(await redis.lRange('ride-requests:{' + r.id + '}:waiting', 0, -1)).toEqual([first, second]);
    expect(await redis.get('ride-requests:{' + r.id + '}:lock')).toBe('replacement');
    await queue.unlock(r.id, 'replacement');
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
  it('an invitation to a different request cannot grant notification eligibility', async () => {
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
  it('Redis still relays when the SQL recovery scan fails, with a fresh ringing notification', async () => {
    await driver(); const second = await driver(15.311), r = await request();
    await relay.advance(r.id);
    await db.query(`UPDATE trip_request_dispatch_offers SET "expiresAt"=now()-interval '1 second' WHERE "requestId"=$1`, [r.id]);
    await queue.schedule(r.id, Date.now() - 1000);
    jest.spyOn(db, 'query').mockRejectedValueOnce(new Error('synthetic recovery scan timeout'));
    await relay.deadlines();
    expect((await offers(r.id)).map(o => o.status)).toEqual(['expired', 'pending']);
    const active = (await notices(r.id)).filter(n => n.isActive);
    expect(active).toHaveLength(1);
    expect(active[0].userId).toBe(second.id);
    expect(active[0].data?.ringAlert).toBe('nearby-request-v1');
    expect(notifications.dispatchUrgentNotifications).toHaveBeenCalledTimes(2);
  });
  it('an expired immediate invitation still rings its successor when the request has received offers', async () => {
    await driver(); const second = await driver(15.311), r = await request(true);
    await relay.advance(r.id);
    await db.getRepository(TripRequest).update(r.id, { status: TripRequestStatus.OFFERS_RECEIVED });
    await db.query(`UPDATE trip_request_dispatch_offers SET "expiresAt"=now()-interval '1 second' WHERE "requestId"=$1`, [r.id]);
    // Recover even after both Redis state and the process have disappeared.
    await queue.close(r.id);
    relay = new SequentialDispatchService(db, config, queue, notifications as never, changes as never);
    dispatch = new DriverDispatchService(db, config, notifications as never, changes as never, relay);
    await dispatch.tick();
    const rows = await offers(r.id);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ driverId: second.id, status: 'pending' });
    const notice = (await notices(r.id)).find(n => n.isActive)!;
    expect(notice.data?.type).toBe('driver_dispatch_offer');
    const delivery = new NotificationService(config, db.getRepository(Notification), db.getRepository(User), db.getRepository(TripRequest));
    expect(await delivery['isCriticalNotificationStillDeliverable'](notice)).toBe(true);
    expect((await dispatch.getOffer(second.id, rows[1].id)).actionable).toBe(true);
    expect(await dispatch.getContactDeadline(second.id, r.id)).not.toBeNull();
    await dispatch.respond(second.id, rows[1].id, 'accept');
    expect(await delivery['isCriticalNotificationStillDeliverable'](notice)).toBe(false);
  });
  it.each(['offline', 'suspended', 'kyc', 'vehicle', 'busy'])('skips a cached candidate whose eligibility changes (%s)', async reason => {
    const first = await driver(), second = await driver(15.311), third = await driver(15.312), r = await request();
    await relay.advance(r.id);
    if (reason === 'offline') await db.query('UPDATE driver_dispatch_presence SET "discoveryEnabled"=false WHERE "driverId"=$1', [second.id]);
    if (reason === 'suspended') await db.getRepository(User).update(second.id, { status: UserStatus.SUSPENDED });
    if (reason === 'kyc') await db.getRepository(KycDocument).update({ userId: second.id }, { status: KycStatus.REJECTED });
    if (reason === 'vehicle') await db.getRepository(Vehicle).update({ ownerId: second.id }, { isActive: false });
    if (reason === 'busy') {
      const other = await request(false, second.id);
      await relay.advance(other.id);
    }
    const seed = jest.spyOn(queue, 'seed');
    await dispatch.receiveRequestEvent(first.id, r.id, (await offers(r.id))[0].id);
    expect((await offers(r.id))[1].driverId).toBe(third.id);
    expect(seed).not.toHaveBeenCalled();
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
  it('retires only closed counteroffers and obsolete request invitations; replay is idempotent', async () => {
    const first = await driver(), r = await request(), other = await request();
    await relay.advance(r.id);
    const [invitation] = await offers(r.id);
    const closed = await db.getRepository(DriverOffer).save({ tripRequestId: r.id, driverId: first.id,
      proposedDepartureDate: r.departureDateMin, pricePerSeat: 1000, availableSeats: 1, status: DriverOfferStatus.REJECTED });
    const active = await db.getRepository(DriverOffer).save({ tripRequestId: r.id, driverId: first.id,
      proposedDepartureDate: r.departureDateMin, pricePerSeat: 1000, availableSeats: 1, status: DriverOfferStatus.PENDING });
    const notice = (requestId: string, type: string, offerId?: string) => db.getRepository(Notification).save({
      userId: r.passengerId, fcmToken: 'fixture', title: 'Fixture', body: 'Fixture',
      data: { tripRequestId: requestId, type, offerId }, isActive: true });
    const rejected = await notice(r.id, 'driver_offer', closed.id);
    const pending = await notice(r.id, 'driver_offer', active.id);
    const unrelatedRequest = await notice(other.id, 'driver_offer', closed.id);
    const unrelatedType = await notice(r.id, 'payment_received', closed.id);
    const legacy = await notice(r.id, 'new_trip_request');
    const malformed = await notice('legacy-non-uuid', 'driver_offer', 'legacy-invalid-offer');
    const clean = () => db.transaction(async manager => {
      await manager.findOneOrFail(TripRequest, { where: { id: r.id }, lock: { mode: 'pessimistic_write' } });
      return retireRequestInvitations(manager, r.id, false);
    });
    expect(await clean()).toBe(false); expect(await clean()).toBe(false);
    const isActive = async (id: string) => (await db.getRepository(Notification).findOneByOrFail({ id })).isActive;
    expect(await isActive(rejected.id)).toBe(false); expect(await isActive(legacy.id)).toBe(false);
    for (const n of [pending, unrelatedRequest, unrelatedType, malformed]) expect(await isActive(n.id)).toBe(true);
    expect((await notices(r.id)).find(n => n.data?.offerId === invitation.id)?.isActive).toBe(true);
    // Passenger decision expiry must close both the counteroffer and its message.
    await db.query(`UPDATE trip_request_dispatch_offers SET phase='passenger',"expiresAt"=now()-interval '1 second' WHERE id=$1`, [invitation.id]);
    expect(await clean()).toBe(true);
    expect(await isActive(pending.id)).toBe(false);
    expect((await db.getRepository(DriverOffer).findOneByOrFail({ id: active.id })).status).toBe('cancelled');
    expect((await offers(r.id))[0].status).toBe('expired');
    for (const n of [unrelatedRequest, unrelatedType, malformed]) expect(await isActive(n.id)).toBe(true);
  });

  it('rolls back retirement on a notification write failure and relays exactly once after recovery', async () => {
    const first = await driver(), second = await driver(15.311), r = await request();
    await relay.advance(r.id);
    await db.query(`UPDATE trip_request_dispatch_offers SET "expiresAt"=now()-interval '1 second' WHERE "requestId"=$1`, [r.id]);
    await db.query(`CREATE FUNCTION fail_retirement_test() RETURNS trigger LANGUAGE plpgsql AS $body$
      BEGIN RAISE EXCEPTION 'synthetic cleanup failure'; END; $body$`);
    await db.query('CREATE TRIGGER fail_retirement_test BEFORE UPDATE ON notifications FOR EACH ROW EXECUTE FUNCTION fail_retirement_test()');
    try {
      expect(await relay.advance(r.id)).toBe(false);
      expect((await offers(r.id)).map(o => o.status)).toEqual(['pending']);
      expect((await notices(r.id))[0].isActive).toBe(true);
      expect(await redis.zScore(REQUEST_DEADLINES_KEY, r.id)).not.toBeNull();
    } finally {
      await db.query('DROP TRIGGER fail_retirement_test ON notifications');
      await db.query('DROP FUNCTION fail_retirement_test()');
    }
    expect(await relay.advance(r.id)).toBe(true);
    expect(await relay.advance(r.id)).toBe(false);
    expect((await offers(r.id)).map(o => [o.driverId, o.status])).toEqual([[first.id, 'expired'], [second.id, 'pending']]);
    expect((await notices(r.id)).filter(n => n.isActive)).toHaveLength(1);
  });

  it('uses the request index and completes creation/refusal/expiry with 211000 historical notifications', async () => {
    const first = await driver(), second = await driver(15.311), third = await driver(15.312), r = await request();
    await seedDispatchNotificationHistory(db, first.id);
    const historyCount = await db.getRepository(Notification).count();
    expect(historyCount).toBe(211_000);
    const runner = db.createQueryRunner();
    const migration = new IndexRequestNotificationRetirement1780000099000();
    const plans: { kind: string; executionMs: number }[] = [];
    const nodes = (plan: any): any[] => [plan, ...(plan.Plans ?? []).flatMap(nodes)];
    await runner.startTransaction();
    try {
      const [budget] = await runner.query(`SELECT current_setting('lock_timeout') AS lock_timeout,
        current_setting('statement_timeout') AS statement_timeout`);
      await migration.down(runner);
      const [before] = await runner.query('EXPLAIN (FORMAT JSON) ' + RETIRE_REQUEST_NOTIFICATIONS_SQL, [r.id, true]);
      expect(nodes(before['QUERY PLAN'][0].Plan).some(n => n['Relation Name'] === 'notifications' && n['Node Type'] === 'Seq Scan')).toBe(true);
      const at = Date.now();
      await migration.up(runner); await migration.up(runner);
      console.log('[request-retirement-index] ' + JSON.stringify({ historyCount, buildAndRecheckMs: Date.now() - at }));
      const [restored] = await runner.query(`SELECT current_setting('lock_timeout') AS lock_timeout,
        current_setting('statement_timeout') AS statement_timeout`);
      expect(restored).toEqual(budget);
      // Execute the actual UPDATE plans, not a different SELECT. Roll back below.
      await runner.query("SET LOCAL statement_timeout='1500ms'");
      for (const terminal of [true, false]) {
        const [result] = await runner.query('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' + RETIRE_REQUEST_NOTIFICATIONS_SQL, [r.id, terminal]);
        const plan = result['QUERY PLAN'][0];
        expect(nodes(plan.Plan).some(n => n['Index Name'] === 'IDX_notifications_active_request_type')).toBe(true);
        expect(nodes(plan.Plan).some(n => n['Relation Name'] === 'notifications' && n['Node Type'] === 'Seq Scan')).toBe(false);
        plans.push({ kind: terminal ? 'terminal' : 'relay', executionMs: plan['Execution Time'] });
      }
      const [counter] = await runner.query('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' + RETIRE_COUNTEROFFER_NOTIFICATIONS_SQL, [r.id, [randomUUID()]]);
      expect(nodes(counter['QUERY PLAN'][0].Plan).some(n => n['Index Name'] === 'IDX_notifications_active_request_type')).toBe(true);
      plans.push({ kind: 'counteroffer', executionMs: counter['QUERY PLAN'][0]['Execution Time'] });
    } finally { await runner.rollbackTransaction(); await runner.release(); }
    expect(await db.getRepository(Notification).count()).toBe(historyCount);
    const measurements: Record<string, number> = {};
    let at = Date.now();
    expect(await relay.advance(r.id)).toBe(true); measurements.creationMs = Date.now() - at;
    const [initial] = await offers(r.id);
    at = Date.now(); await dispatch.receiveRequestEvent(first.id, r.id, initial.id);
    measurements.refusalMs = Date.now() - at;
    expect((await offers(r.id))[1].driverId).toBe(second.id);
    await db.query(`UPDATE trip_request_dispatch_offers SET "expiresAt"=now()-interval '1 second' WHERE "requestId"=$1 AND status='pending'`, [r.id]);
    at = Date.now(); await relay.deadlines(); measurements.expiryMs = Date.now() - at;
    expect((await offers(r.id)).map(o => [o.driverId, o.status])).toEqual([[first.id, 'declined'], [second.id, 'expired'], [third.id, 'pending']]);
    expect((await notices(r.id)).filter(n => n.isActive)).toHaveLength(1);
    await db.getRepository(TripRequest).update(r.id, { status: TripRequestStatus.CANCELLED });
    at = Date.now(); await relay.advance(r.id); measurements.cancellationMs = Date.now() - at;
    expect((await notices(r.id)).filter(n => n.isActive)).toHaveLength(0);
    expect(await db.getRepository(Notification).count()).toBe(historyCount + 3);
    expect(notifications.dispatchUrgentNotifications).toHaveBeenCalledTimes(3);
    console.log('[request-retirement-history] ' + JSON.stringify({ historyCount, plans, ...measurements,
      scope: 'isolated SQL/Redis; no provider or mobile delivery latency' }));
    for (const milliseconds of Object.values(measurements)) expect(milliseconds).toBeLessThan(5000);
  }, 120_000);

  (process.env.DISPATCH_TEST_LOAD === '1' ? it : it.skip)('bounded local benchmark of SQL reservations + real Redis with three dispatcher replicas', async () => {
    const historyOwner = await driver();
    for (let n = 1; n < 120; n++) await driver(15.31 + n * 0.00001);
    await seedDispatchNotificationHistory(db, historyOwner.id);
    const quantile = (samples: number[], percentile: number) => {
      const sorted = [...samples].sort((a, b) => a - b);
      return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * percentile))];
    };
    for (const stage of [{ name: 'serial', concurrency: 1 }, { name: 'concurrent', concurrency: 8 }]) {
      const stageRequests: TripRequest[] = [];
      for (let n = 0; n < 60; n++) stageRequests.push(await request());
      const replicas = Array.from({ length: 3 }, () => new SequentialDispatchService(db, config,
        queue, notifications as never, changes as never));
      const durations: number[] = [], outcomes: boolean[] = [];
      let cursor = 0;
      const started = Date.now();
      const settled = await Promise.allSettled(Array.from({ length: stage.concurrency }, async (_, worker) => {
        while (cursor < stageRequests.length) {
          const r = stageRequests[cursor++], at = Date.now();
          outcomes.push(await replicas[worker % replicas.length].advance(r.id));
          durations.push(Date.now() - at);
        }
      }));
      for (const result of settled) if (result.status === 'rejected') throw result.reason;
      const elapsedMs = Date.now() - started;
      const rows = await db.query(`SELECT "driverId","requestId" FROM trip_request_dispatch_offers WHERE status='pending'`);
      console.log('[sequential-load] ' + JSON.stringify({ stage: stage.name, count: outcomes.length,
        concurrency: stage.concurrency, successful: outcomes.filter(Boolean).length, elapsedMs,
        p50Ms: quantile(durations, .5), p95Ms: quantile(durations, .95), maxMs: Math.max(...durations),
        historyNotifications: 211_000, scope: 'Redis queue to durable SQL invitation/outbox; no real push or phone' }));
      expect(outcomes).toHaveLength(60); expect(outcomes.every(Boolean)).toBe(true);
      expect(rows).toHaveLength(60); expect(new Set(rows.map(r => r.driverId)).size).toBe(60);
      expect(new Set(rows.map(r => r.requestId)).size).toBe(60);
      await db.query(`UPDATE trip_request_dispatch_offers SET status='cancelled' WHERE status='pending'`);
      await db.getRepository(TripRequest).update(stageRequests.map(r => r.id), { status: TripRequestStatus.CANCELLED });
    }
  }, 120_000);
  sequentialMobileFlow(() => ({ db, relay, dispatch, notifications, driver, ids, offers }));
});
