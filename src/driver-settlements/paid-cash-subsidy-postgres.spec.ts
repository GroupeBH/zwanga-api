import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { IsolatedPostgres } from '../../test/isolated-postgres';
import { typeOrmEntities } from '../database/entities';
import {
  Booking,
  BookingPaymentStatus,
  BookingStatus,
} from '../bookings/entities/booking.entity';
import { BookingsService } from '../bookings/bookings.service';
import { Trip, TripStatus } from '../trips/entities/trip.entity';
import { User } from '../users/entities/user.entity';
import { TripPaymentMode } from '../payments/enums/trip-payment-mode.enum';
import {
  WalletAccount,
  WalletAccountType,
} from '../wallet/entities/wallet-account.entity';
import {
  WalletLedgerEntry,
  WalletLedgerEntryType,
} from '../wallet/entities/wallet-ledger-entry.entity';
import { WalletService } from '../wallet/wallet.service';
import { DriverEarning } from './entities/driver-earning.entity';
import { DriverSettlementsService } from './driver-settlements.service';

// Disposable loopback cluster only. No application config, provider or real users.
const bin = process.env.PAID_SUBSIDY_TEST_POSTGRES_BIN;
(bin ? describe : describe.skip)(
  'paid fare after a cash subsidy on isolated PostgreSQL',
  () => {
    jest.setTimeout(90000);
    const cluster = new IsolatedPostgres(bin!);
    let db: DataSource;
    const repo = <T extends object>(target: new () => T) =>
      db.getRepository(target);
    beforeAll(async () => {
      Logger.overrideLogger(false);
      db = await cluster.start();
      db.setOptions({ entities: typeOrmEntities });
      await (
        db as unknown as { buildMetadatas(): Promise<void> }
      ).buildMetadatas();
      await db.query('CREATE EXTENSION postgis; CREATE EXTENSION "uuid-ossp"');
      await db.synchronize();
    });
    afterAll(() => cluster.stop());
    beforeEach(() =>
      db.query('TRUNCATE users, payment_transactions, driver_earnings CASCADE'),
    );

    async function fixture(
      gross = 2000,
      passengerAmount = 800,
      interrupted = false,
    ) {
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
        pricePerSeat: 10000,
        status: TripStatus.ACTIVE,
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
        paymentAmount: passengerAmount,
        grossPaymentAmount: gross,
        zwangaSubsidyAmount: gross - passengerAmount,
        firstTripSubsidyApplied: gross > passengerAmount,
        passengerPaymentRate: passengerAmount / gross,
        interruptionFareLocked: interrupted,
        fareAdjustedAt: interrupted ? new Date() : null,
        cashCommissionTokenValue: 10,
        cashCommissionPolicyVersion: 2,
        paymentCurrency: 'CDF',
      });
      await repo(WalletAccount).save({
        userId: passenger.id,
        type: WalletAccountType.POINTS,
        balance: 200,
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
      booking.trip = trip;
      const subsidy = await settlements.recordCompletedBookingEarning(booking);
      await repo(Booking).update(booking.id, {
        paymentMode: TripPaymentMode.POINTS,
        paymentStatus: BookingPaymentStatus.PENDING,
      });
      const current = await repo(Booking).findOneByOrFail({ id: booking.id });
      current.trip = trip;
      const service = Object.assign(
        Object.create(BookingsService.prototype) as {
          capturePointsPaymentForBooking(
            booking: Booking,
            trip: Trip,
          ): Promise<Booking>;
        },
        {
          dataSource: db,
          bookingRepository: repo(Booking),
          walletService: wallet,
          driverSettlementsService: settlements,
          getTripPaymentCurrency: () => 'CDF',
          canReserveFirstTripSubsidy: () => Promise.resolve(false),
          FIRST_TRIP_SUBSIDY_RELEASED_STATUSES: [
            BookingStatus.CANCELLED,
            BookingStatus.REJECTED,
            BookingStatus.NO_SHOW,
            BookingStatus.EXPIRED,
          ],
          logger: { log: jest.fn(), warn: jest.fn() },
        },
      );
      return {
        booking: current,
        passenger,
        trip,
        subsidy,
        settlements,
        service,
        capture: () => service.capturePointsPaymentForBooking(current, trip),
      };
    }

    it.each([
      ['first trip bonus', 2000, 800, false],
      ['early dropoff with bonus', 1500, 800, true],
      ['early dropoff without bonus', 800, 800, true],
    ])(
      '%s debits only 80 tokens while the driver trip is still active',
      async (_label, gross, passenger, interrupted) => {
        const f = await fixture(gross, passenger, interrupted);
        const paid = await f.capture();
        expect(paid).toMatchObject({
          paymentStatus: BookingPaymentStatus.SUCCEEDED,
          interruptionFareLocked: interrupted,
        });
        // PostgreSQL decimals are returned as strings when the locked fare is kept.
        expect(Number(paid.paymentAmount)).toBe(passenger);
        expect(Number(paid.grossPaymentAmount)).toBe(gross);
        const wallet = await repo(WalletAccount).findOneByOrFail({
          userId: f.passenger.id,
          type: WalletAccountType.POINTS,
        });
        expect(Number(wallet.balance)).toBe(120);
        const earnings = await repo(DriverEarning).findBy({
          bookingId: f.booking.id,
        });
        expect(earnings).toHaveLength(1);
        if (f.subsidy) expect(earnings[0].id).toBe(f.subsidy.id);
        expect(Number(earnings[0].netAmount)).toBe(Number(gross) - 40);
        expect(Number(earnings[0].commissionAmount)).toBe(40);
        expect(
          (await repo(Trip).findOneByOrFail({ id: f.trip.id })).status,
        ).toBe(TripStatus.ACTIVE);
        const ledger = await repo(WalletLedgerEntry).findBy({
          relatedEntityId: f.booking.id,
          type: WalletLedgerEntryType.BOOKING_PAYMENT,
        });
        expect(ledger).toHaveLength(1);
        expect(Number(ledger[0].amount)).toBe(-80);
      },
    );

    it('simultaneous retries settle one debit and upgrade the same subsidy entry once', async () => {
      const f = await fixture();
      await Promise.all([f.capture(), f.capture(), f.capture()]);
      expect(
        await repo(WalletLedgerEntry).countBy({
          relatedEntityId: f.booking.id,
          type: WalletLedgerEntryType.BOOKING_PAYMENT,
        }),
      ).toBe(1);
      const earnings = await repo(DriverEarning).findBy({
        bookingId: f.booking.id,
      });
      expect(earnings).toHaveLength(1);
      expect(earnings[0].id).toBe(f.subsidy!.id);
      expect(Number(earnings[0].netAmount) - Number(f.subsidy!.netAmount)).toBe(
        760,
      );
    });

    it('a genuine ledger inconsistency rolls back both debit and payment confirmation', async () => {
      const f = await fixture();
      await repo(DriverEarning).update(f.subsidy!.id, {
        grossAmount: 1201,
        netAmount: 1201,
      });
      await expect(f.capture()).rejects.toMatchObject({
        response: { code: 'DRIVER_EARNING_RECONCILIATION_REQUIRED' },
      });
      expect(
        Number(
          (
            await repo(WalletAccount).findOneByOrFail({
              userId: f.passenger.id,
            })
          ).balance,
        ),
      ).toBe(200);
      expect(
        await repo(WalletLedgerEntry).countBy({
          relatedEntityId: f.booking.id,
        }),
      ).toBe(0);
      expect(
        (await repo(Booking).findOneByOrFail({ id: f.booking.id }))
          .paymentStatus,
      ).toBe(BookingPaymentStatus.PENDING);
      expect(
        Number(
          (await repo(DriverEarning).findOneByOrFail({ id: f.subsidy!.id }))
            .netAmount,
        ),
      ).toBe(1201);
    });

    it('repeated confirmed electronic finalizations also preserve the subsidy identity', async () => {
      const f = await fixture();
      await repo(Booking).update(f.booking.id, {
        paymentMode: TripPaymentMode.ELECTRONIC,
        paymentStatus: BookingPaymentStatus.SUCCEEDED,
        paidAt: new Date(),
      });
      const paid = await repo(Booking).findOneByOrFail({ id: f.booking.id });
      paid.trip = f.trip;
      await Promise.all([
        f.settlements.recordCompletedBookingEarning(paid),
        f.settlements.recordCompletedBookingEarning(paid),
      ]);
      expect(
        await repo(DriverEarning).countBy({ bookingId: f.booking.id }),
      ).toBe(1);
      expect(
        Number(
          (await repo(DriverEarning).findOneByOrFail({ id: f.subsidy!.id }))
            .netAmount,
        ),
      ).toBe(1960);
      expect(
        await repo(WalletLedgerEntry).countBy({
          relatedEntityId: f.booking.id,
        }),
      ).toBe(0);
    });
  },
);
