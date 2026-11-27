import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { DataSource, Repository } from 'typeorm';
import { IsolatedPostgres } from '../../test/isolated-postgres';
import { typeOrmEntities } from '../database/entities';
import { User, UserRole, UserStatus } from '../users/entities/user.entity';
import { Trip, TripStatus } from '../trips/entities/trip.entity';
import { Booking, BookingStatus } from '../bookings/entities/booking.entity';
import { TripRequest } from '../trip-requests/entities/trip-request.entity';
import { Notification, NotificationStatus } from './entities/notification.entity';
import { NotificationService } from './notifications.service';
import { ownPushClaim, renewPushClaim, saveNotificationResult } from './notification-push-claim';
import { claimTransactionalPushNotifications } from './transactional-push-queue';
import { readPushRecipient } from './read-push-recipient';

const bin = process.env.NOTIFICATIONS_TEST_POSTGRES_BIN;
(bin ? describe : describe.skip)('atomic push claim on isolated PostgreSQL (no external sends)', () => {
  jest.setTimeout(90_000);
  const cluster = new IsolatedPostgres(bin!);
  let db: DataSource, repository: Repository<Notification>;
  beforeAll(async () => {
    db = await cluster.start();
    db.setOptions({ entities: typeOrmEntities });
    await (db as any).buildMetadatas();
    await db.query('CREATE EXTENSION postgis; CREATE EXTENSION "uuid-ossp"');
    await db.synchronize();
    repository = db.getRepository(Notification);
  });
  afterAll(() => cluster.stop());
  beforeEach(() => db.query('TRUNCATE users, notifications CASCADE'));
  afterEach(() => jest.restoreAllMocks());

  function add(overrides: Partial<Notification> = {}) {
    return repository.save(repository.create({
      eventKey: `synthetic:${randomUUID()}`, fcmToken: 'synthetic-device',
      title: 'Synthetic', body: 'Isolated test only', data: { type: 'trip_started' },
      createdAt: new Date(Date.now() - 60_000), updatedAt: new Date(),
      ...overrides,
    }));
  }

  it('reads fresh push ownership and role in exactly one statement, without cached recipients', async () => {
    const users = db.getRepository(User);
    const owner = await users.save({ firstName: 'Synthetic', lastName: 'Owner', fcmToken: 'device-a',
      role: UserRole.DRIVER, isActive: true });
    const query = jest.spyOn(users, 'query');
    expect(await readPushRecipient(users, owner.id)).toMatchObject({ id: owner.id,
      fcmToken: 'device-a', role: UserRole.DRIVER, isActive: true, hasExclusivePushToken: true });
    expect(query).toHaveBeenCalledTimes(1);
    await users.update(owner.id, { fcmToken: 'device-b', role: UserRole.PASSENGER, isActive: false });
    expect(await readPushRecipient(users, owner.id)).toMatchObject({
      fcmToken: 'device-b', role: UserRole.PASSENGER, isActive: false, hasExclusivePushToken: true });
    await users.update(owner.id, { fcmToken: null });
    expect(await readPushRecipient(users, owner.id)).toMatchObject({ fcmToken: null, hasExclusivePushToken: false });
    await users.delete(owner.id);
    expect(await readPushRecipient(users, owner.id)).toBeNull();
    expect(query).toHaveBeenCalledTimes(4);
  });

  it('fails closed for legacy shared tokens, including a disabled second owner without the unique index', async () => {
    const runner = db.createQueryRunner();
    await runner.connect(); await runner.startTransaction();
    try {
      // Isolated synthetic database only. Rolling installations may not have this index yet.
      await runner.query('DROP INDEX "UQ_users_push_token"');
      const users = runner.manager.getRepository(User);
      const owners = await users.save([true, false].map(isActive => ({
        firstName: 'Synthetic', lastName: 'Shared', fcmToken: 'shared-device', isActive,
      })));
      for (const owner of owners) expect(await readPushRecipient(users, owner.id))
        .toMatchObject({ fcmToken: 'shared-device', hasExclusivePushToken: false });
      await users.update(owners[1].id, { fcmToken: null });
      expect(await readPushRecipient(users, owners[0].id)).toMatchObject({ hasExclusivePushToken: true });
    } finally { await runner.rollbackTransaction(); await runner.release(); }
  });

  it.each(['', ' ', ' device ', '\tdevice\n', '\u00a0device\u00a0'])(
    'never normalizes an unproven legacy token into an authorized destination (%j)', async fcmToken => {
      const users = db.getRepository(User);
      const owner = await users.save({ firstName: 'Synthetic', lastName: 'Padded', fcmToken });
      await users.save({ firstName: 'Synthetic', lastName: 'Canonical', fcmToken: 'device' });
      expect(await readPushRecipient(users, owner.id)).toMatchObject({ hasExclusivePushToken: false });
    });

  it('rechecks the driver role, suspension, activation and current token on every preparation', async () => {
    const users = db.getRepository(User);
    const owner = await users.save({ firstName: 'Synthetic', lastName: 'Driver', fcmToken: 'device-a',
      role: UserRole.DRIVER, status: UserStatus.ACTIVE, isActive: true });
    const service = new NotificationService({ get: () => undefined } as unknown as ConfigService,
      repository, users, db.getRepository(TripRequest));
    Object.assign(service, { logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } });
    const prepare = async () => (service as any).prepareSavedNotification(await add({ userId: owner.id,
      data: { type: 'trip_request', passengerId: randomUUID() }, fcmToken: 'stale-snapshot' }));
    try {
      expect(await prepare()).toBe('device-a');
      await users.update(owner.id, { fcmToken: 'device-b' });
      expect(await prepare()).toBe('device-b');
      await users.update(owner.id, { role: UserRole.PASSENGER });
      expect(await prepare()).toBeNull();
      await users.update(owner.id, { role: UserRole.DRIVER, status: UserStatus.SUSPENDED });
      expect(await prepare()).toBeNull();
      await users.update(owner.id, { status: UserStatus.ACTIVE, isActive: false });
      expect(await prepare()).toBeNull();
      await users.update(owner.id, { isActive: true, fcmToken: null });
      expect(await prepare()).toBeNull();
      await users.update(owner.id, { fcmToken: 'device-c' });
      expect(await prepare()).toBe('device-c');
    } finally { service.onModuleDestroy(); }
  });

  it('propagates a failed ownership read instead of trusting a queued token', async () => {
    const query = jest.fn().mockRejectedValue(new Error('synthetic SQL failure'));
    await expect(readPushRecipient({ query }, randomUUID())).rejects.toThrow('synthetic SQL failure');
    expect(query).toHaveBeenCalledTimes(1);
  });
  const ids = (rows: Notification[]) => rows.map(row => row.id);

  it.each([0, -1, 26, 1.5, NaN])('rejects invalid batch size %s before SQL', async limit => {
    const query = jest.fn();
    await expect(claimTransactionalPushNotifications({ query }, true, limit)).rejects.toThrow('between 1 and 25');
    expect(query).not.toHaveBeenCalled();
  });

  it('preserves normal-lane filters, FIFO, dates, payload and event identity in one statement', async () => {
    const first = await add({ createdAt: new Date(Date.now() - 90_000), data: {
      type: 'trip_started', alertExpiresAt: '2026-11-22T19:00:00.000Z', nested: { booked: true },
    } });
    const second = await add({ createdAt: new Date(Date.now() - 80_000) });
    await add({ data: null }); // Legacy untyped, but transactional, remains eligible.
    for (const overrides of [
      { eventKey: null }, { isActive: false }, { data: { type: 'mobile_campaign' } },
      { data: { type: 'driver_dispatch_offer' } }, { status: NotificationStatus.SENT },
      { status: NotificationStatus.FAILED }, { errorMessage: 'already claimed' },
      { pushRetryAt: new Date(Date.now() + 60_000) }, { pushPermanentFailure: true },
    ]) await add(overrides);
    const query = jest.spyOn(repository, 'query');
    const claimed = await claimTransactionalPushNotifications(repository, false, 2);
    expect(ids(claimed)).toEqual([first.id, second.id]);
    expect(query).toHaveBeenCalledTimes(1);
    expect(claimed[0]).toMatchObject({ eventKey: first.eventKey, data: first.data, userId: first.userId });
    expect(claimed[0].createdAt).toBeInstanceOf(Date);
    expect(claimed[0].updatedAt).toBeInstanceOf(Date);
    expect(claimed[0].updatedAt.getTime()).toBeGreaterThanOrEqual(first.updatedAt.getTime());
    expect(claimed[0].errorMessage).toMatch(/^TRANSACTIONAL_PUSH_CLAIMED:/);
    expect(claimed[0].errorMessage).not.toBe(claimed[1].errorMessage);
    expect(await claimTransactionalPushNotifications(repository, false, 25)).toHaveLength(1);
    expect(await claimTransactionalPushNotifications(repository, false, 25)).toEqual([]);
  });

  it('keeps urgent retry delays, lease expiry and new-token recovery without reviving deadlines', async () => {
    const owner = await db.getRepository(User).save({ firstName: 'Synthetic', lastName: 'Owner', fcmToken: 'new-device' });
    const data = { type: 'driver_dispatch_offer', alertExpiresAt: '2026-11-22T19:00:00.000Z' };
    const old = new Date(Date.now() - 60_000);
    const expected: Notification[] = [];
    for (const overrides of [
      {}, { status: NotificationStatus.FAILED, updatedAt: old },
      { errorMessage: 'old-worker', updatedAt: old },
      { pushPermanentFailure: true, userId: owner.id, fcmToken: 'old-device' },
    ]) expected.push(await add({ data, ...overrides }));
    for (const overrides of [
      { status: NotificationStatus.FAILED }, { errorMessage: 'live-worker' },
      { pushRetryAt: new Date(Date.now() + 60_000) },
      { pushPermanentFailure: true, userId: owner.id, fcmToken: 'new-device' },
      { pushPermanentFailure: true }, { isActive: false }, { eventKey: null },
      { status: NotificationStatus.SENT },
    ]) await add({ data, ...overrides });
    const claimed = await claimTransactionalPushNotifications(repository, true, 20);
    expect(ids(claimed).sort()).toEqual(ids(expected).sort());
    expect(claimed.every(row => row.data?.alertExpiresAt === data.alertExpiresAt)).toBe(true);
    expect(await claimTransactionalPushNotifications(repository, true, 20)).toEqual([]);
  });

  it('concurrent claimers receive disjoint, bounded sets with no unclaimed row lost', async () => {
    const expected = await Promise.all(Array.from({ length: 16 }, () => add({ data: { type: 'new_booking' } })));
    const [left, right] = await Promise.all([
      claimTransactionalPushNotifications(repository, true, 8),
      claimTransactionalPushNotifications(repository, true, 8),
    ]);
    expect(left).toHaveLength(8); expect(right).toHaveLength(8);
    expect(new Set(ids([...left, ...right])).size).toBe(16);
    expect(ids([...left, ...right]).sort()).toEqual(ids(expected).sort());
    expect(await claimTransactionalPushNotifications(repository, true, 8)).toEqual([]);
  });

  it('skips a locked oldest row instead of waiting, then claims it after release', async () => {
    const first = await add({ createdAt: new Date(Date.now() - 120_000) }), second = await add();
    const blocker = db.createQueryRunner(), claimant = db.createQueryRunner();
    await blocker.connect(); await claimant.connect();
    try {
      await blocker.startTransaction();
      await blocker.query('SELECT id FROM notifications WHERE id=$1 FOR UPDATE', [first.id]);
      await claimant.query("SET statement_timeout = '2s'");
      expect(ids(await claimTransactionalPushNotifications({ query: (sql, values) => claimant.query(sql, values) }, false, 25))).toEqual([second.id]);
      await blocker.rollbackTransaction();
      expect(ids(await claimTransactionalPushNotifications(repository, false, 25))).toEqual([first.id]);
    } finally {
      if (blocker.isTransactionActive) await blocker.rollbackTransaction();
      await claimant.query('RESET statement_timeout');
      await blocker.release(); await claimant.release();
    }
  });

  it('rolls back the entire claim on SQL failure, leaving every row recoverable', async () => {
    const rows = [await add(), await add()];
    // A validated synthetic UUID, never user input. This constraint exists only in the disposable database.
    await db.query(`ALTER TABLE notifications ADD CONSTRAINT synthetic_claim_failure CHECK (id <> '${rows[1].id}' OR "errorMessage" IS NULL) NOT VALID`);
    try {
      await expect(claimTransactionalPushNotifications(repository, false, 25)).rejects.toThrow();
      expect((await repository.find()).every(row => row.errorMessage === null)).toBe(true);
    } finally { await db.query('ALTER TABLE notifications DROP CONSTRAINT synthetic_claim_failure'); }
    expect(await claimTransactionalPushNotifications(repository, false, 25)).toHaveLength(2);
  });

  it('a replaced worker cannot renew or complete its successor after an expired lease', async () => {
    await add({ data: { type: 'new_booking' } });
    const [old] = await claimTransactionalPushNotifications(repository, true, 1);
    ownPushClaim(old, old.errorMessage!);
    await db.query(`UPDATE notifications SET "updatedAt"=now()-interval '1 minute' WHERE id=$1`, [old.id]);
    const [next] = await claimTransactionalPushNotifications(repository, true, 1);
    ownPushClaim(next, next.errorMessage!);
    expect(next.errorMessage).not.toBe(old.errorMessage);
    expect(await renewPushClaim(repository, old)).toBe(false);
    old.status = NotificationStatus.SENT; old.errorMessage = null;
    expect(await saveNotificationResult(repository, old)).toBe(false);
    expect(await renewPushClaim(repository, next)).toBe(true);
    next.status = NotificationStatus.SENT; next.errorMessage = null;
    expect(await saveNotificationResult(repository, next)).toBe(true);
    expect((await repository.findOneByOrFail({ id: old.id })).status).toBe(NotificationStatus.SENT);
  });

  it.each([
    ['trip_started', 'valid'], ['trip_started', 'cancelled'], ['trip_started', 'disabled'],
    ['trip_started', 'stranger'], ['trip_started', 'completed'],
    ['pickup_confirmed_automatically', 'valid'], ['pickup_confirmed_automatically', 'cancelled'],
    ['pickup_confirmed_automatically', 'disabled'], ['pickup_confirmed_automatically', 'completed'],
    ['dropoff_confirmed_automatically', 'valid'], ['dropoff_confirmed_automatically', 'cancelled'],
    ['dropoff_confirmed_automatically', 'disabled'], ['dropoff_confirmed_automatically', 'stranger'],
  ])('%s revalidates committed business state after claim: %s', async (type, change) => {
    const users = await db.getRepository(User).save([0, 1, 2].map(i => ({
      firstName: 'Synthetic', lastName: `User${i}`, isActive: true, fcmToken: `synthetic-${i}`,
    })));
    const [driver, passenger, stranger] = users;
    const trip = await db.getRepository(Trip).save({ driverId: driver.id,
      departureLocation: 'A', arrivalLocation: 'B', departureDate: new Date(),
      totalSeats: 2, availableSeats: 1, pricePerSeat: 2500, status: TripStatus.ACTIVE });
    const booking = await db.getRepository(Booking).save({ passengerId: passenger.id,
      tripId: trip.id, numberOfSeats: 1, pickedUp: true,
      status: type === 'dropoff_confirmed_automatically' ? BookingStatus.COMPLETED : BookingStatus.ACCEPTED });
    const row = await add({ userId: change === 'stranger' ? stranger.id : passenger.id,
      data: { type, tripId: trip.id, bookingId: booking.id } });
    const service = new NotificationService({ get: () => undefined } as unknown as ConfigService,
      repository, db.getRepository(User), db.getRepository(TripRequest));
    const logger = { log: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
    Object.assign(service, { logger });
    const send = jest.spyOn(service as any, 'sendFirebaseNotification').mockResolvedValue('synthetic-message');
    jest.spyOn(repository, 'query').mockImplementationOnce(async (sql, values) => {
      const claimed = await db.query(sql, values);
      if (change === 'cancelled') await db.getRepository(Booking).update(booking.id, { status: BookingStatus.CANCELLED });
      if (change === 'disabled') await db.getRepository(User).update(passenger.id, { isActive: false });
      if (change === 'completed') await db.getRepository(Trip).update(trip.id, { status: TripStatus.COMPLETED });
      return claimed;
    });
    try {
      await (service as any).dispatchNotificationLane(false);
      expect(logger.error.mock.calls).toEqual([]);
      const stored = await repository.findOneByOrFail({ id: row.id });
      if (change === 'valid') expect(stored).toMatchObject({ status: NotificationStatus.SENT, errorMessage: null });
      expect(send).toHaveBeenCalledTimes(change === 'valid' ? 1 : 0);
      if (change !== 'valid') expect(stored.isActive).toBe(false);
    } finally { service.onModuleDestroy(); }
  });
});
