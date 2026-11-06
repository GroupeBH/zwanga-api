import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { IsolatedPostgres } from '../../test/isolated-postgres';
import { typeOrmEntities } from '../database/entities';
import { AccountLifecycleService } from './account-lifecycle.service';
import { User, UserRole, UserStatus } from './entities/user.entity';
import { Vehicle } from '../vehicles/entities/vehicle.entity';
import { Trip, TripStatus } from '../trips/entities/trip.entity';
import { TripRequest, TripRequestStatus } from '../trip-requests/entities/trip-request.entity';
import { DriverOffer, DriverOfferStatus } from '../trip-requests/entities/driver-offer.entity';
import { Booking, BookingStatus, BookingPaymentStatus } from '../bookings/entities/booking.entity';
import { RecurringTripTemplate } from '../trips/entities/recurring-trip-template.entity';
import { Notification } from '../notifications/entities/notification.entity';
import { WalletAccount, WalletAccountType } from '../wallet/entities/wallet-account.entity';
import { WalletLedgerEntry, WalletLedgerEntryType } from '../wallet/entities/wallet-ledger-entry.entity';
import { WalletService } from '../wallet/wallet.service';
import { TripPaymentMode } from '../payments/enums/trip-payment-mode.enum';
import { lockAvailableAccounts } from './account-availability';
import { TripsService } from '../trips/trips.service';
import { UsersService } from './users.service';
import { assertRequestTarget, requestDriverVisibilitySql } from '../trip-requests/target-driver-policy';

const bin = process.env.ACCOUNT_LIFECYCLE_TEST_POSTGRES_BIN;
(bin ? describe : describe.skip)('account retirement on isolated PostgreSQL', () => {
  jest.setTimeout(120000);
  const cluster = new IsolatedPostgres(bin!);
  let db: DataSource;
  let lifecycle: AccountLifecycleService;
  const cache = { del: jest.fn().mockResolvedValue(undefined) };
  beforeAll(async () => {
    db = await cluster.start();
    db.setOptions({ entities: typeOrmEntities });
    await (db as any).buildMetadatas();
    await db.query('CREATE EXTENSION IF NOT EXISTS postgis');
    await db.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
    await db.synchronize();
    // Dispatch is migration-owned, not an ORM entity. These are its exercised columns.
    await db.query(`CREATE TABLE driver_dispatch_presence ("driverId" uuid PRIMARY KEY, "discoveryEnabled" boolean);
      CREATE TABLE trip_request_dispatch_offers (id uuid PRIMARY KEY, "requestId" uuid, "driverId" uuid,
        status text, phase text DEFAULT 'driver', "expiresAt" timestamptz);
      CREATE TABLE trip_request_driver_refusals ("requestId" uuid, "driverId" uuid,
        PRIMARY KEY ("requestId", "driverId"));`);
    const wallet = Object.assign(Object.create(WalletService.prototype), { dataSource: db,
      ledgerRepository: db.getRepository(WalletLedgerEntry), BOOKING_RELATED_ENTITY_TYPE: 'booking',
      configService: { get: () => undefined }, DEFAULT_POINTS_CURRENCY: 'PTS', logger: { warn: jest.fn() } });
    lifecycle = new AccountLifecycleService(db, wallet, cache as any);
  });
  afterAll(() => cluster.stop(), 40000);
  beforeEach(async () => {
    await db.query('TRUNCATE users, driver_dispatch_presence, trip_request_dispatch_offers, trip_request_driver_refusals CASCADE');
    jest.clearAllMocks();
  });
  const user = (role = UserRole.PASSENGER) => db.getRepository(User).save({ role, firstName: 'Test', lastName: 'Lifecycle',
    isActive: true, status: UserStatus.ACTIVE, accessToken: 'test-session', refreshToken: 'test-refresh' });
  async function fixture() {
    const driver = await user(UserRole.DRIVER), passenger = await user();
    const vehicle = await db.getRepository(Vehicle).save({ ownerId: driver.id, brand: 'Test', model: 'Test', color: 'Test', licensePlate: randomUUID() });
    const trip = await db.getRepository(Trip).save({ driverId: driver.id, vehicleId: vehicle.id, departureLocation: 'A', arrivalLocation: 'B',
      departureDate: new Date('2099-01-01'), pricePerSeat: 1000, totalSeats: 4, availableSeats: 3 });
    const booking = await db.getRepository(Booking).save({ tripId: trip.id, passengerId: passenger.id, numberOfSeats: 1, status: BookingStatus.ACCEPTED });
    const request = await db.getRepository(TripRequest).save({ passengerId: passenger.id, departureLocation: 'A', arrivalLocation: 'B',
      departureDateMin: new Date('2099-01-01'), departureDateMax: new Date('2099-01-02'), numberOfSeats: 1 });
    await db.query('INSERT INTO driver_dispatch_presence VALUES ($1,true)', [driver.id]);
    await db.query(`INSERT INTO trip_request_dispatch_offers(id,"requestId","driverId",status,"expiresAt") VALUES ($1,$2,$3,'pending',now()+interval '1 hour')`,
      [randomUUID(), request.id, driver.id]);
    const alert = await db.getRepository(Notification).save({ userId: driver.id, fcmToken: 'test', title: 'Test', body: 'Test',
      data: { type: 'driver_dispatch_offer', tripRequestId: request.id } });
    return { driver, passenger, vehicle, trip, booking, request, alert };
  }
  it('suspends driver resources, preserves identity/history, and is idempotent', async () => {
    const f = await fixture();
    const done = await db.getRepository(Trip).save({ ...f.trip, id: randomUUID(), status: TripStatus.COMPLETED });
    const template = await db.getRepository(RecurringTripTemplate).save({ driverId: f.driver.id, vehicleId: f.vehicle.id,
      departureLocation: 'A', arrivalLocation: 'B', departureTimeMinutes: 600, weekdays: [1], startDate: '2099-01-01',
      totalSeats: 4, pricePerSeat: 1000 });
    const result = await lifecycle.deactivate(f.driver.id, UserStatus.SUSPENDED);
    expect(result).toMatchObject({ isActive: false, firstName: 'Test', status: 'suspended' });
    expect((await db.manager.findOneByOrFail(Vehicle, { id: f.vehicle.id })).isActive).toBe(false);
    expect((await db.manager.findOneByOrFail(Trip, { id: f.trip.id })).status).toBe('cancelled');
    expect((await db.manager.findOneByOrFail(Trip, { id: done.id })).status).toBe('completed');
    expect((await db.manager.findOneByOrFail(RecurringTripTemplate, { id: template.id })).status).toBe('paused');
    expect((await db.manager.findOneByOrFail(Booking, { id: f.booking.id })).status).toBe('cancelled');
    expect((await db.manager.findOneByOrFail(TripRequest, { id: f.request.id })).status).toBe('pending'); // Other passenger may find another driver.
    expect((await db.manager.findOneByOrFail(Notification, { id: f.alert.id })).isActive).toBe(false);
    expect((await db.query('SELECT * FROM driver_dispatch_presence'))[0].discoveryEnabled).toBe(false);
    await lifecycle.deactivate(f.driver.id, UserStatus.SUSPENDED);
    expect(await db.getRepository(Notification).count({ where: { eventKey: `account-disabled:${f.driver.id}:booking:${f.booking.id}` } })).toBe(1);
    await db.manager.update(User, f.driver.id, { isActive: true, status: UserStatus.ACTIVE });
    expect((await db.manager.findOneByOrFail(Vehicle, { id: f.vehicle.id })).isActive).toBe(false);
  });
  it('cancels passenger requests/invitations and restores seats without cancelling another public trip', async () => {
    const f = await fixture();
    const completed = await db.getRepository(Booking).save({ tripId: f.trip.id, passengerId: f.passenger.id,
      numberOfSeats: 1, status: BookingStatus.COMPLETED, pickedUp: true });
    await lifecycle.deactivate(f.passenger.id, UserStatus.SUSPENDED);
    expect((await db.manager.findOneByOrFail(TripRequest, { id: f.request.id })).status).toBe('cancelled');
    expect((await db.query('SELECT status FROM trip_request_dispatch_offers'))[0].status).toBe('cancelled');
    expect((await db.manager.findOneByOrFail(Notification, { id: f.alert.id })).isActive).toBe(false);
    expect(await db.manager.findOneByOrFail(Trip, { id: f.trip.id })).toMatchObject({ status: 'upcoming', availableSeats: 4 });
    expect((await db.manager.findOneByOrFail(Booking, { id: completed.id })).status).toBe('completed');
  });
  it('rolls back retirement if profile cleanup fails', async () => {
    const f = await fixture();
    await expect(lifecycle.deactivate(f.driver.id, UserStatus.INACTIVE, async () => {
      throw new Error('synthetic cleanup failure');
    })).rejects.toThrow('synthetic cleanup failure');
    expect((await db.manager.findOneByOrFail(User, { id: f.driver.id })).isActive).toBe(true);
    expect((await db.manager.findOneByOrFail(Vehicle, { id: f.vehicle.id })).isActive).toBe(true);
    expect((await db.manager.findOneByOrFail(Booking, { id: f.booking.id })).status).toBe('accepted');
    expect(await db.getRepository(Notification).count({ where: { eventKey: `account-disabled:${f.driver.id}:booking:${f.booking.id}` } })).toBe(0);
    expect(cache.del).not.toHaveBeenCalled();
  });
  it.each([TripRequestStatus.PENDING, TripRequestStatus.OFFERS_RECEIVED])(
    'releases a disabled target for other drivers while preserving the %s request', async status => {
      const f = await fixture(), other = await user(UserRole.DRIVER);
      await db.manager.update(TripRequest, f.request.id, { status, targetDriverId: f.driver.id,
        targetDriverPriorityUntil: new Date(Date.now() + 180000), dispatchCheckedAt: new Date() });
      const visible = () => db.query(`SELECT r.id FROM trip_requests r WHERE r.id=$1
        AND ${requestDriverVisibilitySql('r.id', '$2')}`, [f.request.id, other.id]);
      expect(await visible()).toHaveLength(0);
      await lifecycle.deactivate(f.driver.id, UserStatus.SUSPENDED);
      const request = await db.manager.findOneByOrFail(TripRequest, { id: f.request.id });
      expect(request).toMatchObject({ status, passengerId: f.passenger.id, targetDriverId: null,
        targetDriverPriorityUntil: null, dispatchCheckedAt: null, selectedDriverId: null, tripId: null });
      expect(() => assertRequestTarget(request, other.id)).not.toThrow();
      expect(await visible()).toHaveLength(1);
      expect((await db.query('SELECT status FROM trip_request_dispatch_offers'))[0].status).toBe('cancelled');
      await lifecycle.deactivate(f.driver.id, UserStatus.SUSPENDED);
      expect(await visible()).toHaveLength(1);
    });
  it('rolls back target release and pending invitations if retirement fails', async () => {
    const f = await fixture(), until = new Date(Date.now() + 180000);
    await db.manager.update(TripRequest, f.request.id, { targetDriverId: f.driver.id, targetDriverPriorityUntil: until });
    await expect(lifecycle.deactivate(f.driver.id, UserStatus.INACTIVE, async () => {
      throw new Error('synthetic cleanup failure');
    })).rejects.toThrow('synthetic cleanup failure');
    expect(await db.manager.findOneByOrFail(TripRequest, { id: f.request.id })).toMatchObject({
      targetDriverId: f.driver.id, targetDriverPriorityUntil: until });
    expect((await db.query('SELECT status FROM trip_request_dispatch_offers'))[0].status).toBe('pending');
  });
  it.each([TripRequestStatus.DRIVER_SELECTED, TripRequestStatus.CANCELLED, TripRequestStatus.EXPIRED])(
    'does not reopen a %s request when its former target is disabled', async status => {
      const f = await fixture(), selected = await user(UserRole.DRIVER);
      await db.manager.update(TripRequest, f.request.id, { status, targetDriverId: f.driver.id,
        ...(status === TripRequestStatus.DRIVER_SELECTED ? { selectedDriverId: selected.id } : {}) });
      await lifecycle.deactivate(f.driver.id, UserStatus.SUSPENDED);
      expect(await db.manager.findOneByOrFail(TripRequest, { id: f.request.id })).toMatchObject({
        status, targetDriverId: f.driver.id,
        ...(status === TripRequestStatus.DRIVER_SELECTED ? { selectedDriverId: selected.id } : {}) });
    });
  it('retires the selected driver and accepted offer for an unboarded request', async () => {
    const f = await fixture();
    await db.manager.update(TripRequest, f.request.id, { status: TripRequestStatus.DRIVER_SELECTED,
      selectedDriverId: f.driver.id, tripId: f.trip.id });
    const offer = await db.getRepository(DriverOffer).save({ tripRequestId: f.request.id, driverId: f.driver.id,
      vehicleId: f.vehicle.id, pricePerSeat: 1000, availableSeats: 3, proposedDepartureDate: f.trip.departureDate,
      status: DriverOfferStatus.ACCEPTED });
    await lifecycle.deactivate(f.driver.id, UserStatus.SUSPENDED);
    expect((await db.manager.findOneByOrFail(TripRequest, { id: f.request.id })).status).toBe('cancelled');
    expect((await db.manager.findOneByOrFail(DriverOffer, { id: offer.id })).status).toBe('cancelled');
  });
  it.each(['driver', 'passenger'] as const)('rolls everything back when the %s has an unclosed boarded journey', async role => {
    const f = await fixture();
    await db.manager.update(Booking, f.booking.id, { pickedUp: true, pickedUpAt: new Date() });
    await expect(lifecycle.deactivate(f[role].id, UserStatus.SUSPENDED)).rejects.toMatchObject({ response: { code: 'ACCOUNT_HAS_UNFINISHED_RIDE' } });
    expect((await db.manager.findOneByOrFail(User, { id: f[role].id })).isActive).toBe(true);
    expect((await db.manager.findOneByOrFail(Vehicle, { id: f.vehicle.id })).isActive).toBe(true);
    expect((await db.manager.findOneByOrFail(Booking, { id: f.booking.id })).status).toBe('accepted');
    expect(cache.del).not.toHaveBeenCalled();
  });
  it('refunds token debits once in the retirement transaction without changing token provenance', async () => {
    const f = await fixture();
    const account = await db.getRepository(WalletAccount).save({ userId: f.passenger.id, type: WalletAccountType.POINTS,
      currency: 'PTS', balance: 50, withdrawableBalance: 0 });
    await db.getRepository(WalletLedgerEntry).save({ accountId: account.id, userId: f.passenger.id, type: WalletLedgerEntryType.BOOKING_PAYMENT,
      accountType: WalletAccountType.POINTS, amount: -100, withdrawableAmount: -40, balanceAfter: 50,
      relatedEntityType: 'booking', relatedEntityId: f.booking.id });
    await db.manager.update(Booking, f.booking.id, { paymentMode: TripPaymentMode.POINTS, paymentStatus: BookingPaymentStatus.SUCCEEDED });
    await lifecycle.deactivate(f.passenger.id, UserStatus.SUSPENDED);
    await lifecycle.deactivate(f.passenger.id, UserStatus.SUSPENDED);
    expect(Number((await db.manager.findOneByOrFail(WalletAccount, { id: account.id })).balance)).toBe(150);
    const refunds = await db.manager.find(WalletLedgerEntry, { where: { type: WalletLedgerEntryType.BOOKING_REFUND } });
    expect(refunds).toHaveLength(1);
    expect(Number(refunds[0].withdrawableAmount)).toBe(40);
  });
  it('keeps electronic payment receipts for provider reconciliation', async () => {
    const f = await fixture();
    await db.manager.update(Booking, f.booking.id, { paymentMode: TripPaymentMode.ELECTRONIC, paymentStatus: BookingPaymentStatus.SUCCEEDED, paymentAmount: 1000 });
    await lifecycle.deactivate(f.passenger.id, UserStatus.SUSPENDED);
    expect(await db.manager.findOneByOrFail(Booking, { id: f.booking.id })).toMatchObject({ status: 'cancelled', paymentStatus: 'succeeded' });
  });
  it('self deletion uses the same resource cleanup while keeping historical rows', async () => {
    const f = await fixture();
    const users = Object.assign(Object.create(UsersService.prototype), { accountLifecycle: lifecycle,
      userRepository: db.getRepository(User), kycDocumentRepository: { find: async () => [] },
      fileUploadService: { deleteFile: jest.fn() }, logger: { warn: jest.fn(), debug: jest.fn() } });
    await users.deactivateAccount(f.passenger.id);
    expect(await db.manager.findOneByOrFail(User, { id: f.passenger.id })).toMatchObject({ isActive: false, status: 'inactive', firstName: 'Compte', phone: null });
    expect((await db.manager.findOneByOrFail(TripRequest, { id: f.request.id })).status).toBe('cancelled');
    expect(await db.manager.count(Booking)).toBe(1);
  });
  it('serializes new work against a concurrent disable and rejects it after commit', async () => {
    const f = await fixture();
    const runner = db.createQueryRunner(); await runner.connect(); await runner.startTransaction();
    try {
      await runner.manager.findOne(User, { where: { id: f.driver.id }, lock: { mode: 'pessimistic_write' } });
      const next = db.transaction(tx => lockAvailableAccounts(tx, [f.driver.id]));
      const assertion = expect(next).rejects.toMatchObject({ response: { code: 'ACCOUNT_UNAVAILABLE' } });
      await runner.manager.update(User, f.driver.id, { isActive: false, status: UserStatus.SUSPENDED });
      await runner.commitTransaction(); await assertion;
    } finally { if (runner.isTransactionActive) await runner.rollbackTransaction(); await runner.release(); }
  });
  it('hides old disabled owners even before their old resources are retired', async () => {
    const f = await fixture();
    await db.manager.update(User, f.driver.id, { isActive: false });
    const trips = Object.assign(Object.create(TripsService.prototype), { tripRepository: db.getRepository(Trip),
      logger: { log: jest.fn(), debug: jest.fn() }, buildUserRatingsMap: async () => new Map(),
      subscriptionsService: { getPremiumFeaturesForUsers: async () => new Map() },
      sortSanitizedTripsByPremium: (rows: any[]) => rows, sanitizeTrip: async (row: Trip) => row });
    expect((await trips.searchPage({})).data).toEqual([]);
  });
});
