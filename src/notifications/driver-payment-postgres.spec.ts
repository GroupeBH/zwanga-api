import { createServer, type Server as HttpServer } from 'node:http';
import { once } from 'node:events';
import { Server } from 'socket.io';
import { DataSource, type QueryRunner } from 'typeorm';
import { IsolatedPostgres } from '../../test/isolated-postgres';
import { typeOrmEntities } from '../database/entities';
import { Booking, BookingPaymentStatus, BookingStatus } from '../bookings/entities/booking.entity';
import { Trip, TripStatus } from '../trips/entities/trip.entity';
import { User } from '../users/entities/user.entity';
import { TripPaymentMode } from '../payments/enums/trip-payment-mode.enum';
import { Notification } from './entities/notification.entity';
import { NotificationService } from './notifications.service';
import { NotificationsController } from './notifications.controller';
import { TransactionalNotificationsSubscriber } from './transactional-notifications.subscriber';
import { RideAlertRealtime } from './ride-alert-realtime.service';
import { CashReceiptsService } from '../bookings/cash-receipts.service';
import { IndexRealtimePaymentReceipts1780000100000 } from '../database/migrations/1780000100000-IndexRealtimePaymentReceipts';
import { MixedCashPaymentService } from '../bookings/mixed-cash-payment.service';
import { WalletService } from '../wallet/wallet.service';
import { WalletAccount, WalletAccountType } from '../wallet/entities/wallet-account.entity';
import { WalletLedgerEntry } from '../wallet/entities/wallet-ledger-entry.entity';
import { DriverSettlementsService } from '../driver-settlements/driver-settlements.service';
import { DriverEarning } from '../driver-settlements/entities/driver-earning.entity';

const bin = process.env.MIXED_CASH_TEST_POSTGRES_BIN;
(bin ? describe : describe.skip)('driver payment receipt: PostgreSQL, socket, REST and mobile parser', () => {
  jest.setTimeout(90000);
  const cluster = new IsolatedPostgres(bin!);
  let db: DataSource, subscriber: TransactionalNotificationsSubscriber;
  beforeAll(async () => {
    db = await cluster.start(); db.setOptions({ entities: typeOrmEntities });
    await (db as any).buildMetadatas();
    await db.query('CREATE EXTENSION postgis; CREATE EXTENSION "uuid-ossp"');
    await db.synchronize(); subscriber = new TransactionalNotificationsSubscriber(db);
    // Technical delivery table from migration 88 (not a synchronized entity).
    await db.query(`CREATE TABLE ride_realtime_deliveries (
      "notificationId" uuid PRIMARY KEY REFERENCES notifications(id) ON DELETE CASCADE,
      "attemptedAt" timestamptz NOT NULL DEFAULT clock_timestamp(),
      "completedAt" timestamptz, attempts integer NOT NULL DEFAULT 1)`);
    const runner = db.createQueryRunner();
    try { await new IndexRealtimePaymentReceipts1780000100000().up(runner); }
    finally { await runner.release(); }
  });
  afterAll(async () => { subscriber?.onModuleDestroy(); await cluster.stop(); });
  beforeEach(() => db.query('TRUNCATE users CASCADE'));
  async function fixture() {
    const driver = await db.getRepository(User).save({ firstName: 'Synthetic', lastName: 'Driver', isDriver: true });
    const passenger = await db.getRepository(User).save({ firstName: 'Synthetic', lastName: 'Passenger' });
    const trip = await db.getRepository(Trip).save({ driverId: driver.id, departureLocation: 'A', arrivalLocation: 'B',
      departureDate: new Date(), totalSeats: 1, availableSeats: 1, pricePerSeat: 2000, status: TripStatus.COMPLETED });
    const booking = await db.getRepository(Booking).save({ tripId: trip.id, passengerId: passenger.id, numberOfSeats: 1,
      status: BookingStatus.COMPLETED, droppedOff: true, paymentMode: TripPaymentMode.POINTS,
      paymentStatus: BookingPaymentStatus.PENDING, paymentAmount: 800, paymentCurrency: 'CDF' });
    const realtime = new RideAlertRealtime();
    const service = new NotificationService({ get: () => undefined } as any, db.getRepository(Notification),
      db.getRepository(User), {} as any, realtime);
    return { driver, passenger, trip, booking, service, realtime };
  }
  async function pay(runner: QueryRunner, id: string) {
    const booking = await runner.manager.findOneByOrFail(Booking, { id });
    booking.paymentStatus = BookingPaymentStatus.SUCCEEDED; booking.paidAt = new Date();
    await runner.manager.save(booking);
  }
  it('never exposes a rolled-back receipt and persists only one notification on replay', async () => {
    const f = await fixture(), runner = db.createQueryRunner();
    try {
      await runner.startTransaction(); await pay(runner, f.booking.id);
      expect((await f.service.findDriverPayments(f.driver.id)).notices).toHaveLength(0);
      await runner.rollbackTransaction(); expect(await db.getRepository(Notification).count()).toBe(0);
      await runner.startTransaction(); await pay(runner, f.booking.id); await runner.commitTransaction();
      await runner.startTransaction(); await pay(runner, f.booking.id); await runner.commitTransaction();
      expect(await db.getRepository(Notification).count()).toBe(1);
      expect((await f.service.findDriverPayments(f.driver.id)).notices[0]).toMatchObject({ amount: 800, paymentMode: 'points' });
      expect((await f.service.findDriverPayments(f.passenger.id)).notices).toHaveLength(0);
    } finally { if (runner.isTransactionActive) await runner.rollbackTransaction(); await runner.release(); }
  });
  it('socket hints reload an authenticated REST receipt; a missed socket is recovered by REST and acknowledgement is durable', async () => {
    const f = await fixture();
    const controller = new NotificationsController(f.service);
    const mobileRoot = process.env.RIDE_AUDIT_MOBILE_ROOT;
    if (!mobileRoot) throw new Error('Set RIDE_AUDIT_MOBILE_ROOT for the cross-repository check');
    const { io } = require(`${mobileRoot}/node_modules/socket.io-client`);
    let http: HttpServer | undefined, sockets: Server | undefined, client: any;
    // Identity is a fixture, not production JWT login. No provider or remote network.
    try {
      http = createServer(async (req, res) => {
        try {
        res.setHeader('Content-Type', 'application/json');
        const userId = req.headers['x-test-user'];
        if (![f.driver.id, f.passenger.id].includes(String(userId))) { res.statusCode = 401; res.end('{}'); return; }
        const request = { user: { userId } };
        if (req.method === 'GET') res.end(JSON.stringify(await controller.driverPayments(request)));
        else {
          const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
          res.end(JSON.stringify(await controller.markAsRead(request, JSON.parse(Buffer.concat(chunks).toString()))));
        }
        } catch { res.statusCode = 500; res.end('{}'); }
      });
      sockets = new Server(http); const namespace = sockets.of('/chat');
      namespace.on('connection', socket => { void socket.join(`user:${f.driver.id}`); });
      f.realtime.bind(namespace as any); http.listen(0, '127.0.0.1'); await once(http, 'listening');
      const base = `http://127.0.0.1:${(http.address() as any).port}`;
      client = io(`${base}/chat`, { transports: ['websocket'], reconnection: false }); await once(client, 'connect');
      const pendingHint = once(client, 'ride_alert');
      await db.transaction(async manager => {
        const booking = await manager.findOneByOrFail(Booking, { id: f.booking.id });
        booking.paymentStatus = BookingPaymentStatus.SUCCEEDED; booking.paidAt = new Date(); await manager.save(booking);
      });
      const row = await db.getRepository(Notification).findOneByOrFail({ userId: f.driver.id });
      await f.service.dispatchRealtimeNotifications();
      const [hint] = await pendingHint;
      expect(hint).toEqual({ kind: 'payment', recipientId: f.driver.id, eventId: row.id, bookingId: f.booking.id });
      const read = async (userId = f.driver.id) => (await fetch(`${base}/notifications/driver-payments`, { headers: { 'x-test-user': userId } })).json();
      const snapshot = await read(); expect(snapshot.notices).toHaveLength(1);
      const { loader } = require(`${mobileRoot}/tests/helpers/loadTypeScript.cjs`);
      const load = loader();
      expect(load('features/notifications/rideRealtime.ts').parseRideRealtimeEvent(hint)?.kind).toBe('payment');
      const notices = load('features/driver-payments/paymentInbox.ts').paymentInbox(snapshot, f.driver.id);
      expect(notices[0]).toMatchObject({ amount: 800, bookingId: f.booking.id, mode: 'points' });
      expect(load('features/arrival-payment/paymentAnnouncement.ts').driverPaymentAnnouncement(notices[0]).text).toContain('800 francs congolais');
      client.disconnect();
      expect((await read()).notices).toHaveLength(1);
      await fetch(`${base}/notifications/mark-as-read`, { method: 'PUT', headers: { 'x-test-user': f.passenger.id, 'content-type': 'application/json' }, body: JSON.stringify({ notificationIds: [row.id] }) });
      expect((await read()).notices).toHaveLength(1);
      await fetch(`${base}/notifications/mark-as-read`, { method: 'PUT', headers: { 'x-test-user': f.driver.id, 'content-type': 'application/json' }, body: JSON.stringify({ notificationIds: [row.id] }) });
      expect((await read()).notices).toHaveLength(0);
    } finally { client?.disconnect(); http?.closeAllConnections(); if (sockets) await new Promise<void>(resolve => sockets!.close(() => resolve())); http?.close(); }
  });
  it('only the real cash receipt is shown, not the choice of cash', async () => {
    const f = await fixture();
    await db.getRepository(Booking).save({ ...f.booking, paymentMode: TripPaymentMode.CASH, paymentStatus: BookingPaymentStatus.NOT_REQUIRED });
    expect((await f.service.findDriverPayments(f.driver.id)).notices).toHaveLength(0);
    const bookings = { findOne: (id: string) => db.getRepository(Booking).findOne({ where: { id }, relations: ['trip'] }), invalidateManualRideCaches: async () => {} };
    const receipts = new CashReceiptsService(db.getRepository(Booking), bookings as any);
    await receipts.confirm(f.booking.id, f.driver.id, 800, 'CDF');
    await receipts.confirm(f.booking.id, f.driver.id, 800, 'CDF');
    expect((await f.service.findDriverPayments(f.driver.id)).notices).toHaveLength(1);
    expect((await f.service.findDriverPayments(f.driver.id)).notices[0]).toMatchObject({ type: 'cash_payment_confirmed', amount: 800, tripId: f.trip.id });
  });
  it('persists partial tokens once, excludes failed payments and allows additive index rollback', async () => {
    const f = await fixture();
    await db.getRepository(Booking).save({ ...f.booking, paymentStatus: BookingPaymentStatus.FAILED });
    expect((await f.service.findDriverPayments(f.driver.id)).notices).toHaveLength(0);
    const partial = { ...f.booking, paymentMode: TripPaymentMode.CASH, paymentStatus: BookingPaymentStatus.NOT_REQUIRED,
      paymentAmount: 600, mixedTokenAmount: 200, mixedTokenQuantity: 20, mixedPaymentAt: new Date() };
    await db.getRepository(Booking).save(partial); await db.getRepository(Booking).save(partial);
    const rows = (await f.service.findDriverPayments(f.driver.id)).notices;
    expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ amount: 200, cashRemainder: 600, partial: true });
    const runner = db.createQueryRunner(), migration = new IndexRealtimePaymentReceipts1780000100000();
    try {
      await migration.down(runner);
      expect(await db.getRepository(Notification).count()).toBe(1);
      await migration.up(runner); await migration.up(runner);
      const [index] = await db.query(`SELECT i.indisvalid FROM pg_index i WHERE i.indexrelid=to_regclass('"IDX_notifications_realtime_receipts"')`);
      expect(index.indisvalid).toBe(true);
    } finally { await runner.release(); }
  });
  it('real mixed-payment debit and cash confirmation produce two distinct receipts, never after rollback or concurrent replay', async () => {
    const f = await fixture(), repo = <T extends object>(target: new () => T) => db.getRepository(target);
    await repo(Booking).save({ ...f.booking, paymentMode: TripPaymentMode.CASH, paymentStatus: BookingPaymentStatus.NOT_REQUIRED,
      grossPaymentAmount: 800, pickedUp: true });
    await repo(WalletAccount).save({ userId: f.passenger.id, type: WalletAccountType.POINTS, balance: 20, withdrawableBalance: 0, currency: 'PTS' });
    const wallet = new WalletService(repo(WalletAccount), repo(WalletLedgerEntry), repo(User), db, { get: () => undefined } as never, {} as never);
    const settlements = new DriverSettlementsService(repo(DriverEarning), {} as never, repo(User), {} as never,
      repo(Booking), repo(Trip), { get: () => undefined } as never, {} as never, db, {} as never);
    const bookings = { findOne: (id: string) => repo(Booking).findOneByOrFail({ id }), invalidateManualRideCaches: async () => {} };
    const mixed = new MixedCashPaymentService(db, wallet, settlements, bookings as never);
    const input = { expectedAmount: 800, expectedTokenAmount: 200, tokenQuantity: 20, currency: 'CDF' };
    const failure = jest.spyOn(settlements, 'recordMixedCashEarningWithManager').mockRejectedValueOnce(Error('synthetic accounting failure'));
    await expect(mixed.pay(f.booking.id, f.passenger.id, input)).rejects.toThrow('synthetic accounting failure');
    expect((await f.service.findDriverPayments(f.driver.id)).notices).toHaveLength(0);
    expect(await repo(WalletLedgerEntry).count()).toBe(0); failure.mockRestore();
    await Promise.all([mixed.pay(f.booking.id, f.passenger.id, input), mixed.pay(f.booking.id, f.passenger.id, input)]);
    expect(await repo(WalletLedgerEntry).count()).toBe(1);
    expect(Number((await repo(WalletAccount).findOneByOrFail({ userId: f.passenger.id })).balance)).toBe(0);
    const partial = (await f.service.findDriverPayments(f.driver.id)).notices;
    expect(partial).toHaveLength(1); expect(partial[0]).toMatchObject({ amount: 200, cashRemainder: 600, partial: true });
    await new CashReceiptsService(repo(Booking), bookings as never).confirm(f.booking.id, f.driver.id, 600, 'CDF');
    const received = (await f.service.findDriverPayments(f.driver.id)).notices;
    expect(received).toHaveLength(2); expect(received[1]).toMatchObject({ amount: 600, paymentMode: 'cash' });
  });
});
