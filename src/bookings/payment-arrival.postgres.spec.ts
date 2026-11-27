import { randomUUID } from 'node:crypto';
import { DataSource, EntitySchema } from 'typeorm';
import { IsolatedPostgres } from '../../test/isolated-postgres';
import { Booking } from './entities/booking.entity';
import { Trip } from '../trips/entities/trip.entity';
import { Notification } from '../notifications/entities/notification.entity';
import { PaymentRequestService } from './payment-request.service';
import { completePaidRequestTransaction } from './paid-request-completion';
import { completeTripTransaction } from '../trips/complete-trip-transaction';

const bin = process.env.PAYMENT_ARRIVAL_TEST_POSTGRES_BIN;
(bin ? describe : describe.skip)('arrival and payment on disposable PostgreSQL (no .env/providers)', () => {
  const cluster = new IsolatedPostgres(bin!);
  let db: DataSource;
  const tripId = randomUUID(), bookingId = randomUUID(), driverId = randomUUID(), passengerId = randomUUID();
  const json = { type: 'jsonb' as const, nullable: true };
  const date = { type: 'timestamptz' as const, nullable: true };
  const point = { type: 'Point', coordinates: [15.3, -4.32] };
  beforeAll(async () => {
    const base = await cluster.start();
    db = await new DataSource({ ...base.options, synchronize: true, entities: [
      new EntitySchema({ name: 'Trip', target: Trip, tableName: 'trips', columns: {
        id: { type: 'uuid', primary: true }, driverId: { type: 'uuid' }, tripRequestId: { type: String, nullable: true },
        status: { type: String }, completedAt: date, currentLocation: json, arrivalPoint: json, lastLocationUpdateAt: date,
      } }),
      new EntitySchema<Booking>({ name: 'Booking', target: Booking, tableName: 'bookings', columns: {
        id: { type: 'uuid', primary: true }, tripId: { type: 'uuid' }, passengerId: { type: 'uuid' }, status: { type: String },
        paymentMode: { type: String }, paymentStatus: { type: String }, paymentAmount: { type: 'numeric', nullable: true },
        pickedUp: { type: Boolean, default: false }, pickedUpAt: date, droppedOff: { type: Boolean, default: false },
        cashReceivedAt: date, passengerDestinationPoint: json, interruptionFareLocked: { type: Boolean, default: false },
        rideDeclarations: { ...json, select: false },
      }, relations: { trip: { type: 'many-to-one', target: 'Trip', joinColumn: { name: 'tripId' } } } }),
      new EntitySchema({ name: 'Notification', target: Notification, tableName: 'notifications', columns: {
        id: { type: 'uuid', primary: true, default: () => 'gen_random_uuid()' }, eventKey: { type: String, unique: true },
        userId: { type: 'uuid' }, fcmToken: { type: String }, title: { type: String }, body: { type: String }, data: json,
        isAutomatic: { type: Boolean }, status: { type: String }, createdAt: { type: 'timestamptz', createDate: true },
      } }),
    ] }).initialize();
  }, 90000);
  afterAll(async () => { if (db?.isInitialized) await db.destroy(); await cluster.stop(); }, 45000);
  beforeEach(async () => {
    await db.query('TRUNCATE bookings, trips, notifications CASCADE');
    await db.getRepository(Trip).save({ id: tripId, driverId, tripRequestId: 'request', status: 'ongoing',
      currentLocation: point, arrivalPoint: point, lastLocationUpdateAt: new Date() } as any);
    await db.getRepository(Booking).save({ id: bookingId, tripId, passengerId, status: 'accepted', pickedUp: true,
      paymentMode: 'electronic', paymentStatus: 'pending', paymentAmount: 3000, passengerDestinationPoint: point } as any);
  });
  const finish = () => completePaidRequestTransaction(db.getRepository(Trip), tripId, new Date());
  const update = (values: Partial<Booking>) => db.getRepository(Booking).update(bookingId, values as any);
  it('arrival first waits for payment, then exactly one concurrent worker finishes', async () => {
    await update({ status: 'completed' as any, droppedOff: true });
    expect(await finish()).toBe(null);
    await expect(completeTripTransaction(db.getRepository(Trip), tripId, driverId, new Date(), () => true)).rejects.toThrow('paiement');
    await update({ paymentStatus: 'succeeded' as any });
    expect((await Promise.all([finish(), finish(), finish()])).filter(Boolean)).toHaveLength(1);
    expect((await db.getRepository(Trip).findOneByOrFail({ id: tripId })).status).toBe('completed');
  });
  it('payment first never drops off a passenger; an arrival then closes the request', async () => {
    await update({ paymentStatus: 'succeeded' as any });
    expect(await finish()).toBe(null);
    await update({ status: 'completed' as any, droppedOff: true });
    expect((await finish())?.status).toBe('completed');
  });
  it('defers a busy trip without deadlocking legacy trip-then-booking arrival confirmations', async () => {
    await update({ status: 'completed' as any, droppedOff: true, paymentStatus: 'succeeded' as any });
    const runner = db.createQueryRunner(); await runner.connect(); await runner.startTransaction();
    try {
      await runner.manager.findOne(Trip, { where: { id: tripId }, lock: { mode: 'pessimistic_write' } });
      expect(await finish()).toBe(null);
      await runner.commitTransaction();
      expect((await finish())?.status).toBe('completed');
    } finally { if (runner.isTransactionActive) await runner.rollbackTransaction(); await runner.release(); }
  });
  it('cash and mixed payments remain active until the driver receipt is committed', async () => {
    await update({ status: 'completed' as any, droppedOff: true, paymentMode: 'cash' as any, paymentStatus: 'not_required' as any });
    expect(await finish()).toBe(null);
    await update({ cashReceivedAt: new Date() });
    expect((await finish())?.status).toBe('completed');
  });
  it('a shared/public trip is not automatically ended by payment of its last passenger', async () => {
    await db.getRepository(Trip).update(tripId, { tripRequestId: null } as any);
    await update({ status: 'completed' as any, droppedOff: true, paymentStatus: 'succeeded' as any });
    expect(await finish()).toBe(null);
  });
  it('concurrent invitation retries create one outbox entry and never change the fare/payment', async () => {
    const service = new PaymentRequestService(db.getRepository(Booking));
    const results = await Promise.all([service.request(bookingId, driverId), service.request(bookingId, driverId)]);
    expect(results.every(result => result.requestedAt)).toBe(true);
    expect(await db.getRepository(Notification).count()).toBe(1);
    const booking = await db.getRepository(Booking).findOneByOrFail({ id: bookingId });
    expect(booking.paymentStatus).toBe('pending'); expect(Number(booking.paymentAmount)).toBe(3000);
    expect((await service.read(bookingId, passengerId)).requestedAt).toEqual(results[0].requestedAt);
  });
  it('rejects an unrelated driver and never writes a notification', async () => {
    const service = new PaymentRequestService(db.getRepository(Booking));
    await expect(service.request(bookingId, randomUUID())).rejects.toThrow('conducteur');
    expect(await db.getRepository(Notification).count()).toBe(0);
  });
});
