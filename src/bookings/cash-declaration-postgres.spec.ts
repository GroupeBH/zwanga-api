import { createServer } from 'node:http';
import { once } from 'node:events';
import { DataSource } from 'typeorm';
import { Server } from 'socket.io';
import { IsolatedPostgres } from '../../test/isolated-postgres';
import { typeOrmEntities } from '../database/entities';
import { Booking, BookingPaymentStatus, BookingStatus } from './entities/booking.entity';
import { Trip, TripStatus } from '../trips/entities/trip.entity';
import { User } from '../users/entities/user.entity';
import { TripPaymentMode } from '../payments/enums/trip-payment-mode.enum';
import { CashReceiptsService } from './cash-receipts.service';
import { CashReceiptsController } from './cash-receipts.controller';
import { NotificationService } from '../notifications/notifications.service';
import { Notification } from '../notifications/entities/notification.entity';
import { RideAlertRealtime } from '../notifications/ride-alert-realtime.service';
import { CashDeclarationRealtimeIndex1780000116000 } from '../database/migrations/1780000116000-CashDeclarationRealtimeIndex';

const bin = process.env.MIXED_CASH_TEST_POSTGRES_BIN;
(bin ? describe : describe.skip)('cash declaration: real isolated PostgreSQL, socket/HTTP and mobile contracts', () => {
  jest.setTimeout(90000);
  const cluster = new IsolatedPostgres(bin!);
  let db: DataSource;
  beforeAll(async () => {
    db = await cluster.start(); db.setOptions({ entities: typeOrmEntities }); await (db as any).buildMetadatas();
    await db.query('CREATE EXTENSION postgis; CREATE EXTENSION "uuid-ossp"'); await db.synchronize();
    await db.query(`CREATE TABLE ride_realtime_deliveries ("notificationId" uuid PRIMARY KEY REFERENCES notifications(id) ON DELETE CASCADE,
      "attemptedAt" timestamptz NOT NULL DEFAULT clock_timestamp(), "completedAt" timestamptz, attempts integer NOT NULL DEFAULT 1)`);
    const runner = db.createQueryRunner();
    try { await new CashDeclarationRealtimeIndex1780000116000().up(runner); } finally { await runner.release(); }
  });
  afterAll(() => cluster.stop());
  beforeEach(() => db.query('TRUNCATE users CASCADE'));
  async function fixture(patch: Partial<Booking> = {}) {
    const driver = await db.getRepository(User).save({ firstName: 'Synthetic', lastName: 'Driver', isDriver: true });
    const passenger = await db.getRepository(User).save({ firstName: 'Synthetic', lastName: 'Passenger' });
    const trip = await db.getRepository(Trip).save({ driverId: driver.id, departureLocation: 'A', arrivalLocation: 'B',
      departureDate: new Date(), totalSeats: 1, availableSeats: 0, pricePerSeat: 3500, status: TripStatus.ACTIVE });
    const booking = await db.getRepository(Booking).save({ tripId: trip.id, passengerId: passenger.id, numberOfSeats: 1,
      status: BookingStatus.COMPLETED, droppedOff: true, paymentMode: TripPaymentMode.CASH,
      paymentStatus: BookingPaymentStatus.NOT_REQUIRED, paymentAmount: 2850, paymentCurrency: 'CDF', ...patch });
    const realtime = new RideAlertRealtime();
    const notices = new NotificationService({ get: () => undefined } as any, db.getRepository(Notification), db.getRepository(User), {} as any, realtime);
    const receipts = new CashReceiptsService(db.getRepository(Booking), { findOne: (id: string) => db.getRepository(Booking).findOneByOrFail({ id }),
      invalidateManualRideCaches: async () => {} } as any);
    return { driver, passenger, trip, booking, notices, receipts, realtime };
  }
  it('does not emit on cash choice; explicit declaration is deduplicated under concurrent retries and never confirms collection', async () => {
    const f = await fixture();
    expect((await f.notices.findDriverPayments(f.driver.id)).notices).toHaveLength(0);
    await Promise.all(Array.from({ length: 5 }, () => f.receipts.declare(f.booking.id, f.passenger.id, 2850, 'CDF')));
    expect(await db.getRepository(Notification).count()).toBe(1);
    const saved = await db.getRepository(Booking).findOneByOrFail({ id: f.booking.id });
    expect(saved.cashReceivedAt).toBeNull(); expect(saved.paidAt).toBeNull(); expect(saved.paymentStatus).toBe('not_required');
    expect((await f.notices.findDriverPayments(f.driver.id)).notices[0]).toMatchObject({ type: 'cash_payment_declared', amount: 2850, paymentMode: 'cash' });
    expect((await f.notices.findDriverPayments(f.passenger.id)).notices).toHaveLength(0);
    await f.receipts.confirm(f.booking.id, f.driver.id, 2850, 'CDF');
    await f.receipts.declare(f.booking.id, f.passenger.id, 2850, 'CDF');
    const inbox = await f.notices.findDriverPayments(f.driver.id);
    expect(inbox.notices).toHaveLength(1); expect(inbox.notices[0]).toMatchObject({ type: 'cash_payment_confirmed' });
    const declared = await db.getRepository(Notification).findOneByOrFail({ eventKey: `cash-declaration:${f.booking.id}:2850:CDF` });
    expect(await f.notices['isCriticalNotificationStillDeliverable'](declared)).toBe(false);
    expect((await f.notices.findAllByUser(f.driver.id)).notifications.some(n => n.data?.type === 'cash_payment_declared')).toBe(false);
  });
  it('rejects another participant, a stale fare or currency, a non-arrived booking and non-cash payments', async () => {
    const f = await fixture();
    await expect(f.receipts.declare(f.booking.id, f.driver.id, 2850, 'CDF')).rejects.toMatchObject({ status: 403 });
    for (const [amount, currency] of [[3500, 'CDF'], [2850, 'USD'], [0, 'CDF'], [NaN, 'CDF']] as const)
      await expect(f.receipts.declare(f.booking.id, f.passenger.id, amount, currency)).rejects.toMatchObject({ status: 409 });
    for (const patch of [{ droppedOff: false }, { status: BookingStatus.ACCEPTED }, { paymentMode: TripPaymentMode.POINTS }, { paymentStatus: BookingPaymentStatus.PENDING }]) {
      await db.getRepository(Booking).update(f.booking.id, { status: BookingStatus.COMPLETED, droppedOff: true,
        paymentMode: TripPaymentMode.CASH, paymentStatus: BookingPaymentStatus.NOT_REQUIRED, ...patch });
      await expect(f.receipts.declare(f.booking.id, f.passenger.id, 2850, 'CDF')).rejects.toMatchObject({ status: 400 });
    }
    expect(await db.getRepository(Notification).count()).toBe(0);
  });
  it('hides stale cash declarations if the fare or mode changed, without poisoning the inbox with malformed JSON', async () => {
    const f = await fixture(); await f.receipts.declare(f.booking.id, f.passenger.id, 2850, 'CDF');
    await db.getRepository(Booking).update(f.booking.id, { paymentAmount: 3000 });
    expect((await f.notices.findDriverPayments(f.driver.id)).notices).toHaveLength(0);
    await f.receipts.declare(f.booking.id, f.passenger.id, 3000, 'CDF');
    expect((await f.notices.findDriverPayments(f.driver.id)).notices).toHaveLength(1);
    await db.getRepository(Booking).update(f.booking.id, { paymentMode: TripPaymentMode.POINTS });
    expect((await f.notices.findDriverPayments(f.driver.id)).notices).toHaveLength(0);
    const row = await db.getRepository(Notification).findOneByOrFail({ userId: f.driver.id });
    await db.getRepository(Notification).save({ ...row, data: { ...row.data, bookingId: 'invalid', amount: 'bad' } });
    expect((await f.notices.findDriverPayments(f.driver.id)).notices).toHaveLength(0);
  });
  it('mixed payment announces only the remaining cash; a database rollback publishes no declaration', async () => {
    const f = await fixture({ mixedPaymentAt: new Date(), mixedTokenAmount: 650, mixedTokenQuantity: 65 });
    await expect(f.receipts.declare(f.booking.id, f.passenger.id, 3500, 'CDF')).rejects.toMatchObject({ status: 409 });
    await f.receipts.declare(f.booking.id, f.passenger.id, 2850, 'CDF');
    expect((await f.notices.findDriverPayments(f.driver.id)).notices[0]).toMatchObject({ amount: 2850 });
    const fresh = await fixture();
    const rollbackRepository = { manager: { transaction: (work: any) => db.transaction(async manager => {
      await work(manager); throw Error('synthetic rollback');
    }) } };
    const rollback = new CashReceiptsService(rollbackRepository as any, {} as any);
    await expect(rollback.declare(fresh.booking.id, fresh.passenger.id, 2850, 'CDF')).rejects.toThrow('synthetic rollback');
    expect((await fresh.notices.findDriverPayments(fresh.driver.id)).notices).toHaveLength(0);
  });
  it('additive index is restartable and reversible without removing notifications', async () => {
    const f = await fixture(); await f.receipts.declare(f.booking.id, f.passenger.id, 2850, 'CDF');
    const runner = db.createQueryRunner(), migration = new CashDeclarationRealtimeIndex1780000116000();
    try { await migration.up(runner); await migration.down(runner); await migration.up(runner); }
    finally { await runner.release(); }
    expect((await f.notices.findDriverPayments(f.driver.id)).notices).toHaveLength(1);
  });
  const mobileRoot = process.env.RIDE_AUDIT_MOBILE_ROOT;
  (mobileRoot ? it : it.skip)('passenger mobile mutation → HTTP/DB → socket + REST → mobile cash modal → driver HTTP receipt', async () => {
    const f = await fixture(), controller = new CashReceiptsController(f.receipts);
    // Synthetic participant identity replaces JWT; real controller/service/SQL and mobile hooks are exercised.
    const http = createServer(async (req, res) => {
      res.setHeader('Content-Type', 'application/json');
      try {
        const userId = String(req.headers['x-test-user']);
        if (![f.driver.id, f.passenger.id].includes(userId)) { res.statusCode = 401; res.end('{}'); return; }
        if (req.method === 'GET') res.end(JSON.stringify(await f.notices.findDriverPayments(userId)));
        else {
          const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
          const body = JSON.parse(Buffer.concat(chunks).toString());
          const request = { user: { userId } };
          res.end(JSON.stringify(await (req.url?.endsWith('cash-declaration')
            ? controller.declare(f.booking.id, request, body) : controller.confirm(f.booking.id, request, body))));
        }
      } catch (error) { res.statusCode = error.status ?? 500; res.end(JSON.stringify({ message: error.message })); }
    });
    const sockets = new Server(http), namespace = sockets.of('/chat');
    namespace.on('connection', socket => { void socket.join(`user:${f.driver.id}`); }); f.realtime.bind(namespace as any);
    http.listen(0, '127.0.0.1'); await once(http, 'listening');
    const base = `http://127.0.0.1:${(http.address() as any).port}`, { io } = require('socket.io-client');
    const client = io(`${base}/chat`, { transports: ['websocket'], reconnection: false });
    const { loader } = require(`${mobileRoot}/tests/helpers/loadTypeScript.cjs`);
    const { hookHarness } = require(`${mobileRoot}/tests/helpers/hookHarness.cjs`);
    const hooks = hookHarness(), driverHooks = hookHarness();
    try {
      await once(client, 'connect', { signal: AbortSignal.timeout(10000) });
      const hint = once(client, 'ride_alert', { signal: AbortSignal.timeout(10000) })
        .then(([event]) => ({ event }), error => ({ error }));
      const endpoints = loader()('store/api/booking/cashReceipt.endpoints.ts').buildCashReceiptEndpoints({ mutation: (x: any) => x });
      const mutation = (endpoint: any, userId: string) => (args: any) => ({ unwrap: async () => {
        const query = endpoint.query(args);
        const response = await fetch(base + query.url, { method: query.method,
          headers: { 'content-type': 'application/json', 'x-test-user': userId }, body: JSON.stringify(query.body) });
        if (!response.ok) throw Error(`HTTP ${response.status}`);
        return endpoint.transformResponse(await response.json());
      } });
      const { usePassengerCashDeclaration } = loader({ react: hooks.react, '@/store/api/bookingApi': {
        useDeclareCashPaymentMutation: () => [mutation(endpoints.declareCashPayment, f.passenger.id), { isLoading: false }],
      } })('hooks/arrival-payment/usePassengerCashDeclaration.ts');
      const passenger = hooks.render(() => usePassengerCashDeclaration(() => true));
      await passenger.declare(f.booking.id, 2850, 'CDF'); await f.notices.dispatchRealtimeNotifications();
      expect(await hint).toMatchObject({ event: { kind: 'payment', bookingId: f.booking.id, recipientId: f.driver.id } });
      client.disconnect(); // REST still recovers the pending confirmation after socket loss.
      const read = async () => (await fetch(`${base}/notifications/driver-payments`, { headers: { 'x-test-user': f.driver.id } })).json();
      const notices = loader()('features/driver-payments/paymentInbox.ts').paymentInbox(await read(), f.driver.id);
      expect(notices[0]).toMatchObject({ cashDeclared: true, cashReceived: false, amount: 2850 });
      let confirmed = false;
      const { CashPaymentRequestNotice } = loader({ react: driverHooks.react,
        'react-native': { View: 'View', Text: 'Text', ScrollView: 'Scroll', TouchableOpacity: 'Button', ActivityIndicator: 'Spinner', StyleSheet: { create: (x: any) => x } },
        '@/services/tokenSession': { getTokenSessionVersion: () => 1 },
        '@/utils/errorHelpers': { getApiErrorMessage: () => 'Test error' },
        '@/store/api/bookingApi': { useConfirmCashReceiptMutation: () => [mutation(endpoints.confirmCashReceipt, f.driver.id)] },
      })('features/driver-payments/CashPaymentRequestNotice.tsx');
      const tree = driverHooks.render(() => CashPaymentRequestNotice({ notice: notices[0], active: true,
        onConfirmed: () => { confirmed = true; }, onClose() {} }));
      const all = (node: any): any[] => !node || typeof node !== 'object' ? [] : Array.isArray(node) ? node.flatMap(all) : [node, ...all(node.props?.children)];
      const action = all(tree).find(node => node.type === 'Button');
      await action.props.onPress(); expect(confirmed).toBe(true);
      const after = await read(); expect(after.notices).toHaveLength(1); expect(after.notices[0].type).toBe('cash_payment_confirmed');
    } finally { hooks.unmount(); driverHooks.unmount(); client.disconnect(); http.closeAllConnections();
      await new Promise<void>(resolve => sockets.close(() => resolve())); http.close(); }
  });
});
