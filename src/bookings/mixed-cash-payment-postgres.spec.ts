import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { IsolatedPostgres } from '../../test/isolated-postgres';
import { typeOrmEntities } from '../database/entities';
import { MixedTokensCash1780000089000 } from '../database/migrations/1780000089000-MixedTokensCash';
import {
  Booking,
  BookingPaymentStatus,
  BookingStatus,
} from './entities/booking.entity';
import { Trip, TripStatus } from '../trips/entities/trip.entity';
import { User } from '../users/entities/user.entity';
import {
  WalletAccount,
  WalletAccountType,
} from '../wallet/entities/wallet-account.entity';
import { WalletLedgerEntry } from '../wallet/entities/wallet-ledger-entry.entity';
import { WalletService } from '../wallet/wallet.service';
import { DriverEarning } from '../driver-settlements/entities/driver-earning.entity';
import { DriverSettlementsService } from '../driver-settlements/driver-settlements.service';
import { TripPaymentMode } from '../payments/enums/trip-payment-mode.enum';
import {
  PaymentTransaction,
  PaymentMethod,
  PaymentPurpose,
  PaymentStatus,
} from '../payments/entities/payment-transaction.entity';
import { MixedCashPaymentService } from './mixed-cash-payment.service';
import { CashReceiptsService } from './cash-receipts.service';
import { Notification } from '../notifications/entities/notification.entity';
import { recoverTopUpClaim } from '../payments/topup-recovery';
import { claimTopUpPayment, topUpReference } from '../payments/topup-payment-claim';

// Explicit disposable loopback cluster. No app .env, provider HTTP or production DB.
const bin = process.env.MIXED_CASH_TEST_POSTGRES_BIN;
(bin ? describe : describe.skip)(
  'mixed tokens + cash on isolated PostgreSQL',
  () => {
    jest.setTimeout(90000);
    const cluster = new IsolatedPostgres(bin!);
    let db: DataSource;
    beforeAll(async () => {
      Logger.overrideLogger(false);
      db = await cluster.start();
      db.setOptions({ entities: typeOrmEntities });
      await (
        db as unknown as { buildMetadatas(): Promise<void> }
      ).buildMetadatas();
      await db.query('CREATE EXTENSION postgis; CREATE EXTENSION "uuid-ossp"');
      await db.synchronize();
      await db.query(
        `ALTER TABLE bookings DROP COLUMN "mixedTokenAmount", DROP COLUMN "mixedTokenQuantity", DROP COLUMN "mixedPaymentAt"`,
      );
      const runner = db.createQueryRunner();
      try {
        await runner.startTransaction();
        await new MixedTokensCash1780000089000().up(runner);
        await runner.commitTransaction();
      } catch (error) {
        await runner.rollbackTransaction();
        throw error;
      } finally {
        await runner.release();
      }
    });
    afterAll(() => cluster.stop());
    beforeEach(() =>
      db.query('TRUNCATE users, payment_transactions, driver_earnings CASCADE'),
    );

    async function fixture(balance = 58, subsidy = 0) {
      const repo = <T extends object>(target: new () => T) =>
        db.getRepository(target);
      const passenger = await repo(User).save({
        firstName: 'Synthetic',
        lastName: 'Passenger',
      });
      const driver = await repo(User).save({
        firstName: 'Synthetic',
        lastName: 'Driver',
        isDriver: true,
      });
      const trip = await repo(Trip).save({
        driverId: driver.id,
        departureLocation: 'A',
        arrivalLocation: 'B',
        departureDate: new Date(),
        availableSeats: 1,
        totalSeats: 1,
        pricePerSeat: 4500 + subsidy,
        status: TripStatus.COMPLETED,
      });
      const booking = await repo(Booking).save({
        tripId: trip.id,
        passengerId: passenger.id,
        numberOfSeats: 1,
        status: BookingStatus.COMPLETED,
        droppedOff: true,
        pickedUp: true,
        paymentMode: TripPaymentMode.CASH,
        paymentStatus: BookingPaymentStatus.NOT_REQUIRED,
        paymentAmount: 4500,
        grossPaymentAmount: 4500 + subsidy,
        zwangaSubsidyAmount: subsidy,
        firstTripSubsidyApplied: subsidy > 0,
        cashCommissionTokenValue: 10,
        cashCommissionPolicyVersion: 2,
        paymentCurrency: 'CDF',
      });
      await repo(WalletAccount).save({
        userId: passenger.id,
        type: WalletAccountType.POINTS,
        balance,
        withdrawableBalance: 0,
        currency: 'PTS',
      });
      const wallet = new WalletService(
        repo(WalletAccount),
        repo(WalletLedgerEntry),
        repo(User),
        db,
        { get: () => undefined } as never,
        {} as never,
      );
      const settlements = new DriverSettlementsService(
        repo(DriverEarning),
        {} as never,
        repo(User),
        {} as never,
        repo(Booking),
        repo(Trip),
        { get: () => undefined } as never,
        {} as never,
        db,
        {} as never,
      );
      const bookings = {
        invalidateManualRideCaches: jest.fn(() => Promise.resolve()),
        findOne: (id: string) => repo(Booking).findOneByOrFail({ id }),
      };
      const service = new MixedCashPaymentService(
        db,
        wallet,
        settlements,
        bookings as never,
      );
      const receipts = new CashReceiptsService(
        repo(Booking),
        bookings as never,
      );
      const input = {
        expectedAmount: 4500,
        expectedTokenAmount: 580,
        tokenQuantity: 58,
        currency: 'CDF',
      };
      return {
        service,
        receipts,
        booking,
        trip,
        passenger,
        driver,
        settlements,
        bookings,
        input,
        repo,
      };
    }

    it('atomically records 58 tokens, 3920 cash and 551 driver receivable; concurrent retries debit once', async () => {
      const f = await fixture();
      const results = await Promise.all([
        f.service.pay(f.booking.id, f.passenger.id, f.input),
        f.service.pay(f.booking.id, f.passenger.id, f.input),
      ]);
      expect(results.map((b) => Number(b.paymentAmount))).toEqual([3920, 3920]);
      expect(
        Number(
          (
            await f
              .repo(WalletAccount)
              .findOneByOrFail({ userId: f.passenger.id })
          ).balance,
        ),
      ).toBe(0);
      expect(await f.repo(WalletLedgerEntry).count()).toBe(1);
      expect(await f.repo(PaymentTransaction).count()).toBe(0);
      const earning = await f
        .repo(DriverEarning)
        .findOneByOrFail({ bookingId: f.booking.id });
      expect(Number(earning.grossAmount)).toBe(580);
      expect(Number(earning.commissionAmount)).toBe(29);
      expect(Number(earning.netAmount)).toBe(551);
      expect(await f.repo(Notification).count()).toBe(1);
      expect(results[0].cashReceivedAt).toBeNull();
      await expect(
        f.receipts.confirm(f.booking.id, f.driver.id, 4500, 'CDF'),
      ).rejects.toThrow();
      await f.receipts.confirm(f.booking.id, f.driver.id, 3920, 'CDF');
      await f.service.pay(f.booking.id, f.passenger.id, f.input);
      expect(await f.repo(WalletLedgerEntry).count()).toBe(1);
    });

    it('preserves an already credited subsidy, adding only the new token receivable', async () => {
      const f = await fixture(58, 3000);
      await db.transaction((m) =>
        f.settlements.recordCompletedBookingEarningWithManager(m, {
          ...f.booking,
          trip: f.trip,
        }),
      );
      await f.service.pay(f.booking.id, f.passenger.id, f.input);
      const earnings = await f.repo(DriverEarning).find();
      expect(earnings).toHaveLength(1);
      expect(Number(earnings[0].netAmount)).toBe(3551);
      expect(
        Number(
          (await f.repo(Booking).findOneByOrFail({ id: f.booking.id }))
            .grossPaymentAmount,
        ),
      ).toBe(7500);
    });

    it('rolls back debit and split if driver accounting fails', async () => {
      const f = await fixture();
      jest
        .spyOn(f.settlements, 'recordMixedCashEarningWithManager')
        .mockRejectedValueOnce(new Error('synthetic failure'));
      await expect(
        f.service.pay(f.booking.id, f.passenger.id, f.input),
      ).rejects.toThrow('synthetic failure');
      expect(
        Number(
          (
            await f
              .repo(WalletAccount)
              .findOneByOrFail({ userId: f.passenger.id })
          ).balance,
        ),
      ).toBe(58);
      expect(await f.repo(WalletLedgerEntry).count()).toBe(0);
      expect(await f.repo(Notification).count()).toBe(0);
      expect(
        (await f.repo(Booking).findOneByOrFail({ id: f.booking.id }))
          .mixedPaymentAt,
      ).toBeNull();
    });

    it('rejects insufficient balance and wrong owner without any settlement', async () => {
      const f = await fixture(10);
      await expect(
        f.service.pay(f.booking.id, f.driver.id, f.input),
      ).rejects.toThrow();
      await expect(
        f.service.pay(f.booking.id, f.passenger.id, f.input),
      ).rejects.toThrow('Solde');
      expect(await f.repo(WalletLedgerEntry).count()).toBe(0);
      expect(await f.repo(DriverEarning).count()).toBe(0);
    });

    it('rejects stale amounts, incomplete rides and already received cash', async () => {
      const f = await fixture();
      await expect(
        f.service.pay(f.booking.id, f.passenger.id, {
          ...f.input,
          expectedAmount: 4400,
        }),
      ).rejects.toThrow();
      await expect(
        f.service.pay(f.booking.id, f.passenger.id, {
          ...f.input,
          expectedTokenAmount: 590,
        }),
      ).rejects.toThrow();
      await f.repo(Booking).update(f.booking.id, { droppedOff: false });
      await expect(
        f.service.pay(f.booking.id, f.passenger.id, f.input),
      ).rejects.toThrow();
      await f.repo(Booking).update(f.booking.id, { droppedOff: true });
      await f.receipts.confirm(f.booking.id, f.driver.id, 4500, 'CDF');
      await expect(
        f.service.pay(f.booking.id, f.passenger.id, f.input),
      ).rejects.toThrow();
      expect(await f.repo(WalletLedgerEntry).count()).toBe(0);
    });

    it.each([true, false])('arbitrates recovery against a late topup initiation on the unique index (recovery first: %s)', async recoveryFirst => {
      const f = await fixture(), repo = f.repo(PaymentTransaction);
      const reference = topUpReference(f.passenger.id, 'synthetic-recovery-key');
      const candidate = () => repo.create({ userId: f.passenger.id, purpose: PaymentPurpose.WALLET_TOP_UP,
        relatedEntityType: 'wallet_account', relatedEntityId: f.passenger.id, method: PaymentMethod.MOBILE_MONEY,
        reference, amount: 3920, tokenQuantity: 392, currency: 'CDF', phone: 'synthetic-phone', status: PaymentStatus.PENDING });
      const recover = () => recoverTopUpClaim(repo, candidate());
      const initiate = () => claimTopUpPayment(repo, candidate());
      const results = await Promise.all(recoveryFirst ? [recover(), initiate()] : [initiate(), recover()]);
      const recovery = results[recoveryFirst ? 0 : 1] as PaymentTransaction;
      const initiation = results[recoveryFirst ? 1 : 0] as Awaited<ReturnType<typeof initiate>>;
      expect(await repo.countBy({ reference })).toBe(1);
      expect(recovery.id).toBe(initiation.payment.id);
      if (recovery.status === PaymentStatus.CANCELLED) expect(initiation.created).toBe(false);
      else { expect(recovery.status).toBe(PaymentStatus.PENDING); expect(initiation.created).toBe(true); }
      const replay = await initiate(); expect(replay.created).toBe(false);
    });

    it.each([PaymentStatus.FAILED, PaymentStatus.CANCELLED])('allows a split after a confirmed %s electronic attempt', async status => {
      const f = await fixture();
      await f.repo(PaymentTransaction).save({ userId: f.passenger.id, purpose: PaymentPurpose.TRIP_BOOKING,
        relatedEntityType: 'booking', relatedEntityId: f.booking.id, method: PaymentMethod.MOBILE_MONEY,
        status, reference: 'synthetic-declined', amount: 4500, currency: 'CDF' });
      const result = await f.service.pay(f.booking.id, f.passenger.id, f.input);
      expect(Number(result.paymentAmount)).toBe(3920);
      expect(Number(result.mixedTokenAmount)).toBe(580);
      expect(result.cashReceivedAt).toBeNull();
    });

    it('blocks an existing provider payment, and blocks provider insertion or mode rewrite after a split', async () => {
      const f = await fixture();
      const payment = {
        userId: f.passenger.id,
        purpose: PaymentPurpose.TRIP_BOOKING,
        relatedEntityType: 'booking',
        relatedEntityId: f.booking.id,
        method: PaymentMethod.MOBILE_MONEY,
        status: PaymentStatus.PENDING,
        reference: 'synthetic',
        amount: 4500,
        currency: 'CDF',
      };
      await f.repo(PaymentTransaction).save(payment);
      await expect(
        f.service.pay(f.booking.id, f.passenger.id, f.input),
      ).rejects.toThrow('Mobile Money');
      await f.repo(PaymentTransaction).delete({ reference: 'synthetic' }); // isolated test fixture only
      await f.service.pay(f.booking.id, f.passenger.id, f.input);
      await expect(f.repo(PaymentTransaction).save(payment)).rejects.toThrow(
        'MIXED_PAYMENT_ALREADY_PAID',
      );
      await expect(
        f
          .repo(Booking)
          .update(f.booking.id, { paymentMode: TripPaymentMode.POINTS }),
      ).rejects.toThrow('MIXED_PAYMENT_IMMUTABLE');
      await expect(
        f.repo(Booking).update(f.booking.id, { paymentAmount: 4500 }),
      ).rejects.toThrow('MIXED_PAYMENT_IMMUTABLE');
      await expect(
        f.service.pay(f.booking.id, f.passenger.id, {
          ...f.input,
          tokenQuantity: 50,
        }),
      ).rejects.toThrow();
      await expect(
        f.service.pay(f.booking.id, f.passenger.id, {
          ...f.input,
          expectedTokenAmount: 590,
        }),
      ).rejects.toThrow();
    });

    it('returns the committed response even if cache invalidation fails', async () => {
      const f = await fixture();
      f.bookings.invalidateManualRideCaches.mockRejectedValueOnce(
        new Error('cache outage'),
      );
      expect(
        (await f.service.pay(f.booking.id, f.passenger.id, f.input))
          .mixedPaymentAt,
      ).toBeTruthy();
    });
  },
);
