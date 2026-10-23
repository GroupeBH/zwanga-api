import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { randomUUID } from 'crypto';
import { IsolatedPostgres } from '../../test/isolated-postgres';
import { typeOrmEntities } from '../database/entities';
import { TokenCashFallback1780000091000 } from '../database/migrations/1780000091000-TokenCashFallback';
import { Booking, BookingStatus, BookingPaymentStatus } from './entities/booking.entity';
import { Trip, TripStatus } from '../trips/entities/trip.entity';
import { User } from '../users/entities/user.entity';
import { TripPaymentMode } from '../payments/enums/trip-payment-mode.enum';
import { PaymentTransaction, PaymentMethod, PaymentStatus } from '../payments/entities/payment-transaction.entity';
import { WalletAccount, WalletAccountType } from '../wallet/entities/wallet-account.entity';
import { WalletLedgerEntry, WalletLedgerEntryType } from '../wallet/entities/wallet-ledger-entry.entity';
import { WalletService } from '../wallet/wallet.service';
import { TokenCashFallbackService } from './token-cash-fallback.service';

// Disposable loopback cluster only. No .env, production DB, real provider or push.
const bin = process.env.MIXED_CASH_TEST_POSTGRES_BIN;
(bin ? describe : describe.skip)('token cash fallback on isolated PostgreSQL', () => {
  jest.setTimeout(90000);
  const cluster = new IsolatedPostgres(bin!);
  let db: DataSource;
  beforeAll(async () => {
    Logger.overrideLogger(false);
    db = await cluster.start(); db.setOptions({ entities: typeOrmEntities });
    await (db as unknown as { buildMetadatas(): Promise<void> }).buildMetadatas();
    await db.query('CREATE EXTENSION postgis; CREATE EXTENSION "uuid-ossp"');
    await db.synchronize();
    await db.query('ALTER TABLE bookings DROP COLUMN "tokenCashFallbackAt"');
    await db.transaction(async manager => new TokenCashFallback1780000091000().up(manager.queryRunner!));
  });
  afterAll(() => cluster.stop());
  beforeEach(() => db.query('TRUNCATE users, payment_transactions CASCADE'));
  async function fixture() {
    const passenger = await db.getRepository(User).save({ firstName: 'Synthetic', lastName: 'Passenger' });
    const driver = await db.getRepository(User).save({ firstName: 'Synthetic', lastName: 'Driver', isDriver: true });
    const trip = await db.getRepository(Trip).save({ driverId: driver.id, departureLocation: 'A', arrivalLocation: 'B',
      departureDate: new Date(), availableSeats: 1, totalSeats: 1, pricePerSeat: 4500,
      status: TripStatus.COMPLETED, acceptedPaymentModes: [TripPaymentMode.CASH, TripPaymentMode.POINTS] });
    const booking = await db.getRepository(Booking).save({ tripId: trip.id, passengerId: passenger.id,
      status: BookingStatus.COMPLETED, droppedOff: true, pickedUp: true, paymentMode: TripPaymentMode.POINTS,
      paymentStatus: BookingPaymentStatus.PENDING, paymentAmount: 4500, grossPaymentAmount: 4500,
      cashCommissionTokenValue: 10, paymentCurrency: 'CDF' });
    const wallet = new WalletService(db.getRepository(WalletAccount), db.getRepository(WalletLedgerEntry),
      db.getRepository(User), db, { get: () => undefined } as never, {} as never);
    await db.getRepository(WalletAccount).save({ userId: passenger.id, type: WalletAccountType.POINTS,
      balance: 58, withdrawableBalance: 0, currency: 'PTS' });
    const service = new TokenCashFallbackService(db, { invalidateManualRideCaches: async () => {} } as never);
    const payment = (purpose = 'wallet_top_up', status = PaymentStatus.PENDING) => db.getRepository(PaymentTransaction).save({
      userId: passenger.id, purpose, relatedEntityType: purpose === 'wallet_top_up' ? 'wallet_top_up' : 'booking',
      relatedEntityId: purpose === 'wallet_top_up' ? passenger.id : booking.id,
      method: PaymentMethod.MOBILE_MONEY, status, amount: 3920, tokenQuantity: 392,
      currency: 'CDF', reference: randomUUID(), orderNumber: randomUUID(),
    });
    return { booking, passenger, driver, wallet, payment, service,
      run: () => service.switchToCash(booking.id, passenger.id),
      read: () => db.getRepository(Booking).findOneByOrFail({ id: booking.id }) };
  }
  it.each([PaymentStatus.PENDING, PaymentStatus.FAILED, PaymentStatus.SUCCEEDED])('permits cash while top-up is %s; preserves its reference/status and tokens', async status => {
    const f = await fixture(), payment = await f.payment('wallet_top_up', status);
    const [one, two] = await Promise.all([f.run(), f.run()]);
    expect(one.tokenCashFallbackAt).toEqual(two.tokenCashFallbackAt);
    expect(one).toMatchObject({ paymentMode: 'cash', paymentStatus: 'not_required', paymentAmount: '4500.00', cashReceivedAt: null });
    expect(await db.getRepository(PaymentTransaction).findOneByOrFail({ id: payment.id })).toMatchObject({ status, reference: payment.reference });
    expect(Number((await db.getRepository(WalletAccount).findOneByOrFail({ userId: f.passenger.id })).balance)).toBe(58);
    expect(await db.getRepository(WalletLedgerEntry).count()).toBe(0);
  });
  it.each([PaymentStatus.PENDING, PaymentStatus.INITIATED, PaymentStatus.SUCCEEDED, PaymentStatus.FAILED, PaymentStatus.CANCELLED])('leaves direct booking collection %s in its existing reconciliation flow', async status => {
    const f = await fixture(); await f.payment('trip_booking', status);
    await expect(f.run()).rejects.toMatchObject({ status: 409 });
    expect((await f.read()).tokenCashFallbackAt).toBeNull();
  });
  it.each([TripPaymentMode.CASH, TripPaymentMode.ELECTRONIC])('accepts an unsaved points draft over %s when no direct booking collection exists', async mode => {
    const f = await fixture(); await f.payment();
    await db.getRepository(Booking).update(f.booking.id, { paymentMode: mode });
    expect((await f.run()).paymentMode).toBe('cash');
  });
  it('credits a late verified top-up once but never spends it on the cash ride', async () => {
    const f = await fixture(), payment = await f.payment(); await f.run();
    payment.status = PaymentStatus.SUCCEEDED;
    payment.rawCheckResponse = { code: '0', transaction: { status: '0', amount: '3920', currency: 'CDF',
      reference: payment.reference, orderNumber: payment.orderNumber } };
    await db.getRepository(PaymentTransaction).save(payment);
    await (f.wallet as any).applyTopUpPayment(payment); await (f.wallet as any).applyTopUpPayment(payment);
    expect(Number((await db.getRepository(WalletAccount).findOneByOrFail({ userId: f.passenger.id })).balance)).toBe(450);
    await expect(f.wallet.payForBooking(f.booking, 4500)).rejects.toThrow('TOKEN_CASH_FALLBACK_NO_SECOND_COLLECTION');
    expect(Number((await db.getRepository(WalletAccount).findOneByOrFail({ userId: f.passenger.id })).balance)).toBe(450);
    expect((await f.read()).paymentMode).toBe('cash');
  });
  it('fences late provider insertion and stale booking writes, without breaking cash receipt', async () => {
    const f = await fixture(); await f.run();
    await expect(f.payment('trip_booking')).rejects.toThrow('TOKEN_CASH_FALLBACK_NO_SECOND_COLLECTION');
    await expect(db.getRepository(Booking).save(f.booking)).rejects.toThrow('CHK_token_cash_fallback');
    await expect(db.query('UPDATE bookings SET "tokenCashFallbackAt" = NULL WHERE id = $1', [f.booking.id])).rejects.toThrow('TOKEN_CASH_FALLBACK_IMMUTABLE');
    await db.query('UPDATE bookings SET "cashReceivedAt" = now(), "cashReceivedByDriverId" = $2, "cashReceivedAmount" = "paymentAmount" WHERE id = $1', [f.booking.id, f.driver.id]);
    expect((await f.read()).cashReceivedAt).not.toBeNull();
    expect((await f.run()).cashReceivedAt).not.toBeNull();
  });
  it('rejects another account, pre-arrival and an already paid booking', async () => {
    const f = await fixture();
    await expect(f.service.switchToCash(f.booking.id, f.driver.id)).rejects.toMatchObject({ status: 404 });
    await db.getRepository(Booking).update(f.booking.id, { droppedOff: false });
    await expect(f.run()).rejects.toMatchObject({ status: 409 });
    await db.getRepository(Booking).update(f.booking.id, { droppedOff: true, paymentStatus: BookingPaymentStatus.SUCCEEDED });
    await expect(f.run()).rejects.toMatchObject({ status: 409 });
  });
  it('serializes token capture against cash: exactly one wins, never both', async () => {
    const f = await fixture();
    await db.getRepository(WalletAccount).update({ userId: f.passenger.id }, { balance: 500 });
    const settle = () => db.transaction(async manager => {
      const b = await manager.findOneOrFail(Booking, { where: { id: f.booking.id }, lock: { mode: 'pessimistic_write' } });
      if (b.tokenCashFallbackAt) throw new Error('cash chosen');
      await f.wallet.payForBookingWithManager(manager, b, 4500);
      b.paymentStatus = BookingPaymentStatus.SUCCEEDED; await manager.save(b);
    });
    const results = await Promise.allSettled([settle(), f.run()]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const b = await f.read();
    const ledger = await db.getRepository(WalletLedgerEntry).countBy({ type: WalletLedgerEntryType.BOOKING_PAYMENT });
    expect(ledger).toBe(b.tokenCashFallbackAt ? 0 : 1);
    expect(Number((await db.getRepository(WalletAccount).findOneByOrFail({ userId: f.passenger.id })).balance)).toBe(b.tokenCashFallbackAt ? 500 : 50);
  });
  it('serializes a late provider initiation against the cash choice before external collection', async () => {
    const f = await fixture();
    const results = await Promise.allSettled([f.run(), f.payment('trip_booking')]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const count = await db.getRepository(PaymentTransaction).countBy({ purpose: 'trip_booking' });
    expect(count).toBe((await f.read()).tokenCashFallbackAt ? 0 : 1);
  });
});
