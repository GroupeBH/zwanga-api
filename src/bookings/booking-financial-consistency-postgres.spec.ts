import { Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DataSource, EntityTarget } from 'typeorm';
import { IsolatedPostgres } from '../../test/isolated-postgres';
import { typeOrmEntities } from '../database/entities';
import { MixedTokensCash1780000089000 } from '../database/migrations/1780000089000-MixedTokensCash';
import { TokenCashFallback1780000091000 } from '../database/migrations/1780000091000-TokenCashFallback';
import {
  Booking,
  BookingPaymentStatus,
  BookingStatus,
} from './entities/booking.entity';
import { BookingsService } from './bookings.service';
import { Trip, TripStatus } from '../trips/entities/trip.entity';
import { User } from '../users/entities/user.entity';
import { PaymentsService } from '../payments/payments.service';
import {
  PaymentTransaction,
  PaymentStatus,
  PaymentProvider,
  PaymentMethod,
} from '../payments/entities/payment-transaction.entity';
import { TripPaymentMode } from '../payments/enums/trip-payment-mode.enum';
import { completeTripTransaction } from '../trips/complete-trip-transaction';
import {
  lockTripBookingCreation,
  withBookableTrip,
} from './bookable-trip-transaction';
import {
  WalletAccount,
  WalletAccountType,
} from '../wallet/entities/wallet-account.entity';
import {
  WalletLedgerEntry,
  WalletLedgerEntryType,
} from '../wallet/entities/wallet-ledger-entry.entity';
import { DriverEarning } from '../driver-settlements/entities/driver-earning.entity';
import { DriverSettlementsService } from '../driver-settlements/driver-settlements.service';

// CI already provides this opt-in. Fresh loopback DB only; no .env or live payment transport.
const bin = process.env.PAYOUT_TEST_POSTGRES_BIN;
(bin ? describe : describe.skip)(
  'booking financial consistency on isolated PostgreSQL',
  () => {
    jest.setTimeout(180000);
    const cluster = new IsolatedPostgres(bin!);
    let db: DataSource;
    let protection: { restore(): void; count(): number } | undefined;
    const repo = <T extends object>(entity: EntityTarget<T>) =>
      db.getRepository(entity);
    const noop = async () => undefined;
    const logger = {
      log: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    };
    beforeAll(async () => {
      Logger.overrideLogger(false);
      db = await cluster.start();
      protection = require('../../test/load/isolation.cjs').restrictConnections(
        [(db.options as { port: number }).port],
      );
      db.setOptions({ entities: typeOrmEntities });
      await (
        db as unknown as { buildMetadatas(): Promise<void> }
      ).buildMetadatas();
      await db.query('CREATE EXTENSION postgis; CREATE EXTENSION "uuid-ossp"');
      await db.synchronize();
      // Exercise the existing cash/token guards too, not only the TypeORM schema.
      await db.query(
        'ALTER TABLE bookings DROP COLUMN "mixedTokenAmount", DROP COLUMN "mixedTokenQuantity", DROP COLUMN "mixedPaymentAt", DROP COLUMN "tokenCashFallbackAt"',
      );
      await db.transaction(async (manager) => {
        await new MixedTokensCash1780000089000().up(manager.queryRunner!);
        await new TokenCashFallback1780000091000().up(manager.queryRunner!);
      });
    });
    afterAll(async () => {
      protection?.restore();
      await cluster.stop();
    });
    afterEach(() => {
      expect(protection?.count()).toBe(0);
    });

    async function fixture(tokenValue = 10) {
      const driver = await repo(User).save({
        firstName: 'Synthetic',
        lastName: 'Driver',
      });
      const passenger = await repo(User).save({
        firstName: 'Synthetic',
        lastName: 'Passenger',
      });
      const trip = await repo(Trip).save({
        driverId: driver.id,
        departureLocation: 'A',
        arrivalLocation: 'B',
        departureDate: new Date(),
        totalSeats: 4,
        availableSeats: 4,
        pricePerSeat: 5000,
        status: TripStatus.ACTIVE,
      });
      const booking = await repo(Booking).save({
        tripId: trip.id,
        passengerId: passenger.id,
        numberOfSeats: 1,
        status: BookingStatus.COMPLETED,
        droppedOff: true,
        paymentMode: TripPaymentMode.ELECTRONIC,
        paymentStatus: BookingPaymentStatus.PENDING,
        paymentAmount: 5000,
        grossPaymentAmount: 5000,
        paymentCurrency: 'CDF',
        cashCommissionTokenValue: tokenValue,
      });
      const payments: any = Object.assign(
        Object.create(PaymentsService.prototype),
        {
          logger,
          paymentTransactionRepository: repo(PaymentTransaction),
          MAX_FLEXPAY_REFERENCE_LENGTH: 25,
          resolveProviders: () => [PaymentProvider.FLEXPAY],
          getProviderCallbackUrl: () => 'https://example.invalid/callback',
          initiateFlexPayDeposit: jest.fn(
            async (payment: PaymentTransaction) => {
              // Another connection can lock the booking while HTTP is in progress.
              await db.transaction(async (manager) => {
                await manager.query("SET LOCAL lock_timeout = '2s'");
                await manager.findOne(Booking, {
                  where: { id: booking.id },
                  lock: { mode: 'pessimistic_write' },
                });
              });
              return repo(PaymentTransaction).save({
                ...payment,
                status: PaymentStatus.INITIATED,
                orderNumber: randomUUID(),
              });
            },
          ),
        },
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
      const service: any = Object.assign(
        Object.create(BookingsService.prototype),
        {
          logger,
          dataSource: db,
          bookingRepository: repo(Booking),
          tripRepository: repo(Trip),
          paymentsService: payments,
          BOOKING_RELATED_ENTITY_TYPE: 'booking',
          getTripPaymentCurrency: () => 'CDF',
          getBookingFlexPayCallbackUrl: () =>
            'https://example.invalid/callback',
          applyFirstTripSubsidyPolicy: noop,
          invalidateBookingCaches: noop,
          finalizeCompletedBooking: jest.fn(),
          buildPaymentResponse: (b: Booking, p: PaymentTransaction) => ({
            booking: b,
            payment: p,
          }),
          logBookingPaymentResponse() {},
          driverSettlementsService: settlements,
          referralsService: { reverseBookingReward: jest.fn() },
          walletService: {
            payForBookingWithManager: jest.fn(() => {
              throw new Error('Recovery must never debit');
            }),
          },
        },
      );
      const pay = (method = PaymentMethod.MOBILE_MONEY) =>
        service.initiateBookingPayment(booking.id, passenger.id, {
          method,
          phone: '+243900000001',
        });
      const load = () => repo(Booking).findOneByOrFail({ id: booking.id });
      const apply = (payment: PaymentTransaction) =>
        service.applyPaymentToBooking(booking, payment);
      return {
        service,
        payments,
        booking,
        trip,
        driver,
        passenger,
        pay,
        load,
        apply,
      };
    }

    it('concurrent initiation sends once, persists one attempt, and releases DB locks before HTTP', async () => {
      const f = await fixture();
      const results = await Promise.all([f.pay(), f.pay(), f.pay()]);
      expect(new Set(results.map((result) => result.payment.id)).size).toBe(1);
      expect(
        await repo(PaymentTransaction).count({
          where: { relatedEntityId: f.booking.id },
        }),
      ).toBe(1);
      expect(f.payments.initiateFlexPayDeposit).toHaveBeenCalledTimes(1);
    });
    it('changing payment method or losing the provider reference cannot send again', async () => {
      const f = await fixture();
      const first = await f.pay();
      await repo(PaymentTransaction).update(first.payment.id, {
        status: PaymentStatus.PENDING,
        orderNumber: null,
      });
      const retry = await f.pay(PaymentMethod.CARD);
      expect(retry.payment.id).toBe(first.payment.id);
      expect(retry.payment.method).toBe(PaymentMethod.MOBILE_MONEY);
      expect(f.payments.initiateFlexPayDeposit).toHaveBeenCalledTimes(1);
    });
    it('allows retry after definitive failure, but an old failure cannot overwrite its success or reverse rewards', async () => {
      const f = await fixture();
      const first = await f.pay();
      const failed = await repo(PaymentTransaction).save({
        ...first.payment,
        status: PaymentStatus.FAILED,
      });
      await f.apply(failed);
      const retry = await f.pay();
      expect(retry.payment.id).not.toBe(first.payment.id);
      const paid = await repo(PaymentTransaction).save({
        ...retry.payment,
        status: PaymentStatus.SUCCEEDED,
        paidAt: new Date(),
      });
      await f.apply(paid);
      await f.apply(failed); // caller deliberately carries an old booking snapshot
      expect(await f.load()).toMatchObject({
        paymentStatus: BookingPaymentStatus.SUCCEEDED,
        paymentTransactionId: paid.id,
      });
      expect(
        f.service.referralsService.reverseBookingReward,
      ).not.toHaveBeenCalled();
      expect((await f.pay()).payment.id).toBe(paid.id);
      expect(f.payments.initiateFlexPayDeposit).toHaveBeenCalledTimes(2);
    });
    it('a stale initiation result cannot downgrade a callback that already succeeded', async () => {
      const f = await fixture();
      f.payments.initiateFlexPayDeposit.mockImplementation(
        async (payment: PaymentTransaction) => {
          const paid = await repo(PaymentTransaction).save({
            ...payment,
            status: PaymentStatus.SUCCEEDED,
            paidAt: new Date(),
          });
          await f.apply(paid);
          return { ...payment, status: PaymentStatus.INITIATED };
        },
      );
      await f.pay();
      expect((await f.load()).paymentStatus).toBe(
        BookingPaymentStatus.SUCCEEDED,
      );
    });
    it('simultaneous failure and success leave the booking paid, without reward reversal', async () => {
      const f = await fixture();
      const { payment } = await f.pay();
      await Promise.all([
        f.apply({
          ...payment,
          status: PaymentStatus.SUCCEEDED,
          paidAt: new Date(),
        }),
        f.apply({ ...payment, status: PaymentStatus.FAILED }),
      ]);
      expect((await f.load()).paymentStatus).toBe(
        BookingPaymentStatus.SUCCEEDED,
      );
      expect(
        f.service.referralsService.reverseBookingReward,
      ).not.toHaveBeenCalled();
    });
    it('does not relink a paid booking to a different successful historical attempt', async () => {
      const f = await fixture();
      const first = await f.pay();
      await f.apply({ ...first.payment, status: PaymentStatus.SUCCEEDED });
      await f.apply({
        ...first.payment,
        id: randomUUID(),
        status: PaymentStatus.SUCCEEDED,
      });
      expect((await f.load()).paymentTransactionId).toBe(first.payment.id);
    });

    const arrived = (booking: Booking) => booking.droppedOff;
    it('rechecks after a new passenger commits while completion waits for the creation gate', async () => {
      const f = await fixture();
      const runner = db.createQueryRunner();
      await runner.startTransaction();
      let completion: Promise<unknown> | undefined;
      try {
        await lockTripBookingCreation(runner.manager, f.trip.id);
        completion = completeTripTransaction(
          repo(Trip),
          f.trip.id,
          f.driver.id,
          new Date(),
          arrived,
        ).catch((error) => error);
        await runner.manager.save(Booking, {
          tripId: f.trip.id,
          passengerId: f.passenger.id,
          numberOfSeats: 1,
          status: BookingStatus.ACCEPTED,
          paymentMode: TripPaymentMode.CASH,
        });
        await runner.commitTransaction();
        expect(await completion).toMatchObject({ status: 400 });
        expect(
          (await repo(Trip).findOneByOrFail({ id: f.trip.id })).status,
        ).toBe(TripStatus.ACTIVE);
      } finally {
        if (runner.isTransactionActive) await runner.rollbackTransaction();
        await runner.release();
        await completion;
      }
    });
    it('locks pending bookings too and rechecks an acceptance committed before the trip lock', async () => {
      const f = await fixture();
      const pending = await repo(Booking).save({
        tripId: f.trip.id,
        passengerId: f.passenger.id,
        numberOfSeats: 1,
        status: BookingStatus.PENDING,
      });
      const runner = db.createQueryRunner();
      await runner.startTransaction();
      let completion: Promise<unknown> | undefined;
      try {
        await runner.manager.findOne(Booking, {
          where: { id: pending.id },
          lock: { mode: 'pessimistic_write' },
        });
        completion = completeTripTransaction(
          repo(Trip),
          f.trip.id,
          f.driver.id,
          new Date(),
          arrived,
        ).catch((error) => error);
        await runner.manager.update(Booking, pending.id, {
          status: BookingStatus.ACCEPTED,
        });
        await runner.commitTransaction();
        expect(await completion).toMatchObject({ status: 400 });
      } finally {
        if (runner.isTransactionActive) await runner.rollbackTransaction();
        await runner.release();
        await completion;
      }
    });
    it('completion wins once; later passenger creation is rejected', async () => {
      const f = await fixture();
      const completed = await Promise.all(
        [1, 2].map(() =>
          completeTripTransaction(
            repo(Trip),
            f.trip.id,
            f.driver.id,
            new Date(),
            arrived,
          ),
        ),
      );
      expect(completed.sort()).toEqual([false, true]);
      await expect(
        withBookableTrip(repo(Trip), f.trip.id, 1, async () => 'unexpected'),
      ).rejects.toMatchObject({ status: 400 });
    });

    async function tokenFixture(paid: boolean, tokenValue = 10) {
      const f = await fixture(tokenValue);
      await repo(Booking).update(f.booking.id, {
        paymentMode: TripPaymentMode.POINTS,
        paymentStatus: paid
          ? BookingPaymentStatus.SUCCEEDED
          : BookingPaymentStatus.PENDING,
      });
      const account = await repo(WalletAccount).save({
        userId: f.passenger.id,
        type: WalletAccountType.POINTS,
        balance: 0,
        currency: 'PTS',
      });
      const debit = await repo(WalletLedgerEntry).save({
        accountId: account.id,
        userId: f.passenger.id,
        accountType: WalletAccountType.POINTS,
        type: WalletLedgerEntryType.BOOKING_PAYMENT,
        amount: -5000 / tokenValue,
        balanceAfter: 0,
        currency: 'PTS',
        relatedEntityType: 'booking',
        relatedEntityId: f.booking.id,
      });
      const recover = () =>
        f.service.capturePointsPaymentForBooking(
          { ...f.booking, paymentMode: TripPaymentMode.POINTS },
          f.trip,
          true,
        );
      return { ...f, account, debit, recover };
    }
    it.each([false, true])(
      'repairs a missing earning (already paid=%s) exactly once with no new debit',
      async (paid) => {
        const f = await tokenFixture(paid);
        await Promise.all([f.recover(), f.recover()]);
        expect(
          await repo(DriverEarning).count({
            where: { bookingId: f.booking.id },
          }),
        ).toBe(1);
        expect(
          Number(
            (
              await repo(DriverEarning).findOneByOrFail({
                bookingId: f.booking.id,
              })
            ).netAmount,
          ),
        ).toBe(4750);
        expect(
          await repo(WalletLedgerEntry).count({
            where: { relatedEntityId: f.booking.id },
          }),
        ).toBe(1);
        expect(
          Number(
            (await repo(WalletAccount).findOneByOrFail({ id: f.account.id }))
              .balance,
          ),
        ).toBe(0);
        expect(
          f.service.walletService.payForBookingWithManager,
        ).not.toHaveBeenCalled();
        expect((await f.load()).paymentStatus).toBe(
          BookingPaymentStatus.SUCCEEDED,
        );
      },
    );
    it.each(['missing', 'refunded', 'insufficient', 'not_completed'])(
      'refuses unsafe token recovery: %s',
      async (scenario) => {
        const f = await tokenFixture(false);
        if (scenario === 'missing')
          await repo(WalletLedgerEntry).delete(f.debit.id);
        if (scenario === 'refunded')
          await repo(WalletLedgerEntry).save({
            ...f.debit,
            id: randomUUID(),
            type: WalletLedgerEntryType.BOOKING_REFUND,
            amount: 500,
          });
        if (scenario === 'insufficient')
          await repo(WalletLedgerEntry).update(f.debit.id, { amount: -1 });
        if (scenario === 'not_completed')
          await repo(Booking).update(f.booking.id, {
            status: BookingStatus.ACCEPTED,
          });
        await expect(f.recover()).rejects.toMatchObject({ status: 409 });
        expect(
          await repo(DriverEarning).count({
            where: { bookingId: f.booking.id },
          }),
        ).toBe(0);
        expect((await f.load()).paymentStatus).toBe(
          BookingPaymentStatus.PENDING,
        );
        expect(
          f.service.walletService.payForBookingWithManager,
        ).not.toHaveBeenCalled();
      },
    );
    it('keeps a historical 100 CDF quote instead of repricing the debit at 10 CDF', async () => {
      const f = await tokenFixture(true, 100);
      await f.recover();
      expect(
        Number(
          (await repo(WalletLedgerEntry).findOneByOrFail({ id: f.debit.id }))
            .amount,
        ),
      ).toBe(-50);
      expect(
        Number(
          (
            await repo(DriverEarning).findOneByOrFail({
              bookingId: f.booking.id,
            })
          ).netAmount,
        ),
      ).toBe(4750);
      expect(
        f.service.walletService.payForBookingWithManager,
      ).not.toHaveBeenCalled();
    });
    it('rolls back the paid flag if earning persistence fails', async () => {
      const f = await tokenFixture(false);
      f.service.driverSettlementsService.recordCompletedBookingEarningWithManager =
        jest.fn().mockRejectedValue(new Error('simulated ledger outage'));
      await expect(f.recover()).rejects.toThrow('simulated ledger outage');
      expect((await f.load()).paymentStatus).toBe(BookingPaymentStatus.PENDING);
      expect(
        await repo(DriverEarning).count({ where: { bookingId: f.booking.id } }),
      ).toBe(0);
    });
  },
);
