import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { IsolatedPostgres } from '../../test/isolated-postgres';
import { typeOrmEntities } from './entities';
import { ReferralBookingRecovery1780000086000 } from './migrations/1780000086000-ReferralBookingRecovery';
import { ReferralWithdrawalIdempotency1780000085000 } from './migrations/1780000085000-ReferralWithdrawalIdempotency';
import { ReferralsService } from '../referrals/referrals.service';
import { ReferralBookingReconciliationService } from '../referrals/referral-booking-reconciliation.service';
import { ReferralProfile } from '../referrals/entities/referral-profile.entity';
import { ReferralAccount } from '../referrals/entities/referral-account.entity';
import { ReferralReward } from '../referrals/entities/referral-reward.entity';
import { ReferralLedgerEntry } from '../referrals/entities/referral-ledger-entry.entity';
import { ReferralWithdrawal } from '../referrals/entities/referral-withdrawal.entity';
import { User, UserStatus } from '../users/entities/user.entity';
import { KycDocument } from '../users/entities/kyc-document.entity';
import { PaymentTransaction } from '../payments/entities/payment-transaction.entity';
import { Booking, BookingStatus, BookingPaymentStatus } from '../bookings/entities/booking.entity';
import { CashReceiptsService } from '../bookings/cash-receipts.service';
import { Trip } from '../trips/entities/trip.entity';
import { TripPaymentMode } from '../payments/enums/trip-payment-mode.enum';
import { WalletAccount, WalletAccountType } from '../wallet/entities/wallet-account.entity';
import { WalletLedgerEntry, WalletLedgerEntryType } from '../wallet/entities/wallet-ledger-entry.entity';

const bin = process.env.REFERRAL_TEST_POSTGRES_BIN ?? process.env.PAYOUT_TEST_POSTGRES_BIN;
(bin ? describe : describe.skip)('durable trip referral rewards and migration safety', () => {
  jest.setTimeout(90000);
  const cluster = new IsolatedPostgres(bin!);
  let db: DataSource;
  let referrals: ReferralsService;
  let worker: ReferralBookingReconciliationService;
  beforeAll(async () => {
    Logger.overrideLogger(false);
    db = await cluster.start();
    db.setOptions({ entities: typeOrmEntities });
    await (db as any).buildMetadatas();
    await db.query('CREATE EXTENSION IF NOT EXISTS postgis; CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
    await db.synchronize();
    // Exercise the actual additive migration, not only TypeORM's target schema.
    await db.query('DROP INDEX "IDX_referral_withdrawal_intent"; DROP INDEX "IDX_referral_withdrawal_recent"; ALTER TABLE referral_withdrawals DROP COLUMN "idempotencyKey"');
    await db.transaction(async manager => {
      await new ReferralWithdrawalIdempotency1780000085000().up(manager.queryRunner!);
      await new ReferralBookingRecovery1780000086000().up(manager.queryRunner!);
    });
  });
  afterAll(() => cluster.stop());
  beforeEach(async () => {
    await db.query('TRUNCATE users, payment_transactions CASCADE');
    referrals = new ReferralsService(
      db.getRepository(ReferralProfile), db.getRepository(ReferralAccount), db.getRepository(ReferralReward),
      db.getRepository(ReferralLedgerEntry), db.getRepository(ReferralWithdrawal), db.getRepository(User),
      db.getRepository(KycDocument), db.getRepository(PaymentTransaction), db,
      { get: () => undefined } as any, {} as any, {} as any, {} as any,
    );
    worker = new ReferralBookingReconciliationService(db, referrals);
  });

  async function fixture() {
    const users = await db.getRepository(User).save(['Passenger', 'Driver', 'Referrer'].map(lastName => ({
      firstName: 'Synthetic', lastName, isActive: true, status: UserStatus.ACTIVE,
    })));
    const [passenger, driver, referrer] = users;
    await db.getRepository(ReferralProfile).save({
      userId: passenger.id, code: randomUUID().replace(/-/g, '').slice(0, 10),
      linkToken: randomUUID(), referredByUserId: referrer.id, referredAt: new Date(Date.now() - 86400000),
    });
    const trip = await db.getRepository(Trip).save({ driverId: driver.id, departureLocation: 'A', arrivalLocation: 'B',
      departureDate: new Date(), availableSeats: 2, pricePerSeat: 10000 });
    const booking = await db.getRepository(Booking).save({
      tripId: trip.id, passengerId: passenger.id, numberOfSeats: 1, status: BookingStatus.COMPLETED,
      droppedOff: true, droppedOffAt: new Date(), paymentMode: TripPaymentMode.CASH,
      paymentStatus: BookingPaymentStatus.NOT_REQUIRED, paymentAmount: 4000, grossPaymentAmount: 10000,
      zwangaSubsidyAmount: 6000, firstTripSubsidyApplied: true, paymentCurrency: 'CDF',
    });
    const receipts = new CashReceiptsService(db.getRepository(Booking), {
      invalidateManualRideCaches: async () => undefined,
      findOne: (id: string) => db.getRepository(Booking).findOneByOrFail({ id }),
    } as any);
    const confirm = () => receipts.confirm(booking.id, driver.id, 4000, 'CDF');
    const job = async () => (await db.query('SELECT * FROM referral_booking_jobs WHERE "bookingId" = $1', [booking.id]))[0];
    return { passenger, driver, referrer, booking, confirm, job };
  }

  it('does not credit cash at completion; a confirmed receipt earns 1% of passenger cash, not the subsidy', async () => {
    const f = await fixture();
    await expect(referrals.awardBookingReward(f.booking)).resolves.toBeNull();
    expect(await f.job()).toBeUndefined();
    await f.confirm();
    expect(await f.job()).toMatchObject({ cashEligible: true, completedAt: null });
    await worker.reconcile();
    expect(await db.getRepository(ReferralReward).findOneByOrFail({ sourceEntityId: f.booking.id })).toMatchObject({
      grossAmount: '4000.00', rewardAmount: '40.00', rewardTokens: '4.00', rate: '0.010000', paymentTransactionId: null,
    });
    expect(await db.getRepository(ReferralAccount).findOneByOrFail({ userId: f.referrer.id }))
      .toMatchObject({ pendingTokens: '4.00', availableTokens: '0.00' });
    expect((await f.job()).completedAt).toBeInstanceOf(Date);
  });

  it('recovers a cash receipt committed before a process crash and deduplicates concurrent rewards', async () => {
    const f = await fixture();
    const booking = await f.confirm();
    await Promise.all([referrals.awardBookingReward(booking), worker.reconcile(), worker.reconcile()]);
    await f.confirm();
    await worker.reconcile();
    expect(await db.getRepository(ReferralReward).count()).toBe(1);
    expect(await db.getRepository(ReferralLedgerEntry).count()).toBe(1);
  });

  it('rolls back a failed credit and retries it after backoff', async () => {
    const f = await fixture();
    await f.confirm();
    const failure = jest.spyOn(referrals as any, 'createLedgerEntry').mockRejectedValueOnce(new Error('synthetic ledger interruption'));
    await worker.reconcile();
    expect(await f.job()).toMatchObject({ completedAt: null, attempts: 1, lastError: 'REWARD_SETTLEMENT_FAILED' });
    expect(await db.getRepository(ReferralReward).count()).toBe(0);
    failure.mockRestore();
    await db.query('UPDATE referral_booking_jobs SET "nextAttemptAt" = now()');
    await worker.reconcile();
    expect(await db.getRepository(ReferralReward).count()).toBe(1);
    expect((await f.job()).completedAt).toBeInstanceOf(Date);
  });

  it('does not pay a historical receipt when it is merely saved again', async () => {
    const f = await fixture();
    await db.transaction(async manager => {
      await manager.query('ALTER TABLE bookings DISABLE TRIGGER zwanga_queue_booking_referral');
      await manager.query('UPDATE bookings SET "cashReceivedAt" = now(), "cashReceivedAmount" = 4000, "cashReceivedByDriverId" = $2 WHERE id = $1', [f.booking.id, f.driver.id]);
      await manager.query('ALTER TABLE bookings ENABLE TRIGGER zwanga_queue_booking_referral');
    });
    const booking = await f.confirm();
    expect(await f.job()).toBeUndefined();
    expect(await referrals.awardBookingReward(booking)).toBeNull();
    expect(await db.getRepository(ReferralReward).count()).toBe(0);
  });

  it('rechecks a cancelled cash booking rather than trusting a stale receipt object', async () => {
    const f = await fixture();
    const snapshot = await f.confirm();
    await db.getRepository(Booking).update(f.booking.id, { status: BookingStatus.CANCELLED });
    expect(await referrals.awardBookingReward(snapshot)).toBeNull();
    await worker.reconcile();
    expect(await db.getRepository(ReferralReward).count()).toBe(0);
  });

  it('recovers a points reward even when payment and driver settlement had already committed', async () => {
    const f = await fixture();
    const account = await db.getRepository(WalletAccount).save({ userId: f.passenger.id, type: WalletAccountType.POINTS, currency: 'PTS', balance: 1000 });
    await db.getRepository(WalletLedgerEntry).save({ userId: f.passenger.id, accountId: account.id,
      accountType: WalletAccountType.POINTS, currency: 'PTS', type: WalletLedgerEntryType.BOOKING_PAYMENT,
      amount: -400, balanceAfter: 1000, relatedEntityType: 'booking', relatedEntityId: f.booking.id });
    await db.getRepository(Booking).update(f.booking.id, { paymentMode: TripPaymentMode.POINTS, paymentStatus: BookingPaymentStatus.SUCCEEDED, paidAt: new Date() });
    expect(await f.job()).toMatchObject({ cashEligible: false, completedAt: null });
    await worker.reconcile();
    expect(await db.getRepository(ReferralReward).count()).toBe(1);
    expect((await f.job()).completedAt).toBeInstanceOf(Date);
  });

  it('keeps an unbacked points payment under review instead of inventing a referral credit', async () => {
    const f = await fixture();
    await db.getRepository(Booking).update(f.booking.id, { paymentMode: TripPaymentMode.POINTS, paymentStatus: BookingPaymentStatus.SUCCEEDED, paidAt: new Date() });
    await worker.reconcile();
    expect(await db.getRepository(ReferralReward).count()).toBe(0);
    expect(await f.job()).toMatchObject({ completedAt: null, lastError: 'REWARD_SETTLEMENT_FAILED' });
  });

  it('replays a lost worker acknowledgement without paying twice', async () => {
    const f = await fixture();
    await f.confirm();
    await worker.reconcile();
    await db.query(`UPDATE referral_booking_jobs SET "completedAt" = NULL, "nextAttemptAt" = now(),
      "leaseToken" = $1, "leaseUntil" = now() - interval '1 second'`, [randomUUID()]);
    await worker.reconcile();
    expect(await db.getRepository(ReferralReward).count()).toBe(1);
    expect(await db.getRepository(ReferralLedgerEntry).count()).toBe(1);
    expect((await f.job()).completedAt).toBeInstanceOf(Date);
  });

  it('does not erase durable jobs on rollback', async () => {
    const f = await fixture(); await f.confirm();
    await expect(db.transaction(manager => new ReferralBookingRecovery1780000086000().down(manager.queryRunner!))).rejects.toThrow('Referral work exists');
    expect(await f.job()).toBeDefined();
  });

  it('keeps used withdrawal keys on rollback and enforces their uniqueness per owner', async () => {
    const f = await fixture();
    const input = { userId: f.referrer.id, idempotencyKey: randomUUID(), tokens: 1000, amount: 10000, currency: 'CDF', moneyPerToken: 10, phone: '243891234567', requestedAt: new Date() };
    await db.getRepository(ReferralWithdrawal).save(input);
    await expect(db.getRepository(ReferralWithdrawal).save({ ...input, id: randomUUID() })).rejects.toMatchObject({ driverError: { code: '23505' } });
    await expect(db.transaction(manager => new ReferralWithdrawalIdempotency1780000085000().down(manager.queryRunner!))).rejects.toThrow('Idempotency keys in use');
  });
});
