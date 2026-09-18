import { Logger } from '@nestjs/common';
import {
  Booking,
  BookingPaymentStatus,
  BookingStatus,
} from '../bookings/entities/booking.entity';
import { TripPaymentMode } from '../payments/enums/trip-payment-mode.enum';
import { Trip, TripStatus } from '../trips/entities/trip.entity';
import { User } from '../users/entities/user.entity';
import {
  WalletAccount,
  WalletAccountType,
} from './entities/wallet-account.entity';
import {
  WalletLedgerEntry,
  WalletLedgerEntryType,
} from './entities/wallet-ledger-entry.entity';
import { WalletService } from './wallet.service';

describe('Trip loyalty: base token, paid bonus and replay protection', () => {
  let service: WalletService;
  let entries: WalletLedgerEntry[];
  let accounts: Map<string, WalletAccount>;
  let legacy: WalletLedgerEntry | null;
  let manager: {
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let transaction: jest.Mock;
  let config: Record<string, string | number>;
  const ride = (overrides: Partial<Booking> = {}) =>
    ({
      id: 'booking-1',
      tripId: 'trip-1',
      passengerId: 'passenger-1',
      numberOfSeats: 3,
      status: BookingStatus.COMPLETED,
      pickedUp: true,
      droppedOff: true,
      paymentMode: TripPaymentMode.CASH,
      paymentStatus: BookingPaymentStatus.NOT_REQUIRED,
      paymentCurrency: 'CDF',
      paymentAmount: 5000,
      travelledDistanceMeters: 4500,
      ...overrides,
    }) as Booking;
  const trip = (overrides: Partial<Trip> = {}) =>
    ({
      id: 'trip-1',
      driverId: 'driver-1',
      status: TripStatus.COMPLETED,
      startedAt: new Date('2026-09-17T20:00:00Z'),
      completedAt: new Date('2026-09-17T21:00:00Z'),
      ...overrides,
    }) as Trip;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    entries = [];
    accounts = new Map();
    legacy = null;
    config = { ZWANGA_POINT_VALUE_CDF: 100 };
    const query = {
      innerJoin: jest.fn(),
      where: jest.fn(),
      andWhere: jest.fn(),
      getOne: jest.fn(async () => legacy),
    };
    query.innerJoin.mockReturnValue(query);
    query.where.mockReturnValue(query);
    query.andWhere.mockReturnValue(query);
    manager = {
      findOne: jest.fn(async (entity, { where }) => {
        if (entity === User) return { id: where.id };
        if (entity === WalletAccount) return accounts.get(where.userId) ?? null;
        if (entity === WalletLedgerEntry)
          return (
            entries.find((entry) =>
              Object.entries(where).every(
                ([key, value]) => entry[key] === value,
              ),
            ) ?? null
          );
        return null;
      }),
      create: jest.fn((entity, data) => Object.assign(new entity(), data)),
      save: jest.fn(async (row) => {
        row.id ??= `id-${entries.length}-${accounts.size}`;
        if (row instanceof WalletAccount) accounts.set(row.userId, row);
        else if (!entries.includes(row)) entries.push(row);
        return row;
      }),
      createQueryBuilder: jest.fn(() => query),
    };
    // Model the user-row lock: overlapping reward calls observe committed entries.
    let serial: Promise<unknown> = Promise.resolve();
    transaction = jest.fn((callback) => {
      const result = serial.then(() => callback(manager));
      serial = result.catch(() => undefined);
      return result;
    });
    service = new WalletService(
      {} as any,
      {} as any,
      {} as any,
      { transaction } as any,
      { get: (key: string) => config[key] } as any,
      {} as any,
    );
  });
  afterEach(() => jest.restoreAllMocks());

  it.each([0, 5000, 100000])(
    'credits exactly one passenger token for cash, even with distance and price %s',
    async (amount) => {
      config.ZWANGA_LOYALTY_BASE_REWARD = 5; // obsolete runtime setting must not override the rule
      await service.awardLoyaltyForBooking(ride(), amount);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        userId: 'passenger-1',
        amount: 1,
        type: WalletLedgerEntryType.LOYALTY_REWARD,
        relatedEntityType: 'trip_loyalty_base',
        relatedEntityId: 'trip-1',
      });
      expect(accounts.get('passenger-1')?.balance).toBe(1);
    },
  );

  it.each([TripPaymentMode.POINTS, TripPaymentMode.ELECTRONIC])(
    'awards base then distance bonus only after %s succeeds',
    async (paymentMode) => {
      const booking = ride({
        paymentMode,
        paymentStatus: BookingPaymentStatus.PENDING,
      });
      await service.awardLoyaltyForBooking(booking, 5000);
      expect(accounts.get(booking.passengerId)?.balance).toBe(1);
      booking.paymentStatus = BookingPaymentStatus.SUCCEEDED;
      await service.awardLoyaltyForBooking(booking, 5000);
      await service.awardLoyaltyForBooking(booking, 5000);
      expect(entries.map((entry) => entry.amount)).toEqual([1, 2.25]);
      expect(accounts.get(booking.passengerId)?.balance).toBe(3.25);
    },
  );

  it('uses the price bonus when no distance is available, without adding both bonuses', async () => {
    await service.awardLoyaltyForBooking(
      ride({
        paymentMode: TripPaymentMode.ELECTRONIC,
        paymentStatus: BookingPaymentStatus.SUCCEEDED,
        travelledDistanceMeters: null,
      }),
      5000,
    );
    expect(entries.map((entry) => entry.amount)).toEqual([1, 0.5]);
  });

  it('keeps the existing distance minimum for successful non-cash payments', async () => {
    await service.awardLoyaltyForBooking(
      ride({
        paymentMode: TripPaymentMode.POINTS,
        paymentStatus: BookingPaymentStatus.SUCCEEDED,
        travelledDistanceMeters: 100,
      }),
      5000,
    );
    expect(entries.map((entry) => entry.amount)).toEqual([1, 1]);
  });

  it.each([
    BookingPaymentStatus.PENDING,
    BookingPaymentStatus.INITIATED,
    BookingPaymentStatus.FAILED,
    BookingPaymentStatus.CANCELLED,
    BookingPaymentStatus.NOT_REQUIRED,
  ])('gives no paid bonus for status %s', async (paymentStatus) => {
    await service.awardLoyaltyForBooking(
      ride({ paymentMode: TripPaymentMode.ELECTRONIC, paymentStatus }),
      5000,
    );
    expect(entries.map((entry) => entry.amount)).toEqual([1]);
  });

  it.each([0, -1, NaN])(
    'gives only the base for a nonpositive/invalid paid amount %s',
    async (amount) => {
      await service.awardLoyaltyForBooking(
        ride({
          paymentMode: TripPaymentMode.POINTS,
          paymentStatus: BookingPaymentStatus.SUCCEEDED,
        }),
        amount,
      );
      expect(entries.map((entry) => entry.amount)).toEqual([1]);
    },
  );

  it.each([
    BookingStatus.ACCEPTED,
    BookingStatus.PENDING,
    BookingStatus.CANCELLED,
    BookingStatus.REJECTED,
    BookingStatus.NO_SHOW,
    BookingStatus.BOARDING_UNCERTAIN,
    BookingStatus.EXPIRED,
  ])('does not reward an uncompleted transport: %s', async (status) => {
    await service.awardBaseLoyaltyForBooking(ride({ status }));
    await service.awardLoyaltyForBooking(ride({ status }), 5000);
    expect(transaction).not.toHaveBeenCalled();
  });

  it('requires boarding evidence, accepting legacy timestamps', async () => {
    await service.awardBaseLoyaltyForBooking(ride({ pickedUp: false }));
    expect(entries).toHaveLength(0);
    await service.awardBaseLoyaltyForBooking(
      ride({ pickedUp: false, pickedUpAt: new Date() }),
    );
    expect(entries).toHaveLength(1);
  });

  it('does not multiply tokens by seats, bookings or concurrent replays', async () => {
    await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        service.awardLoyaltyForBooking(
          ride({
            id: `booking-${index}`,
            numberOfSeats: index + 1,
            paymentMode: TripPaymentMode.POINTS,
            paymentStatus: BookingPaymentStatus.SUCCEEDED,
          }),
          5000,
        ),
      ),
    );
    expect(entries.map((entry) => entry.amount)).toEqual([1, 2.25]);
    expect(manager.findOne).toHaveBeenCalledWith(User, {
      where: { id: 'passenger-1' },
      select: ['id'],
      lock: { mode: 'pessimistic_write' },
    });
  });

  it('preserves the legacy combined booking reward without extra credits', async () => {
    legacy = { id: 'old-entry', amount: 3.25 } as WalletLedgerEntry;
    expect(await service.awardLoyaltyForBooking(ride(), 5000)).toBe(legacy);
    expect(entries).toHaveLength(0);
    expect(manager.save).not.toHaveBeenCalled();
  });

  it('awards the driver exactly one token per started and completed trip', async () => {
    await Promise.all([
      service.awardLoyaltyForCompletedTrip(trip()),
      service.awardLoyaltyForCompletedTrip(trip()),
    ]);
    await service.awardBaseLoyaltyForBooking(ride());
    await service.awardBaseLoyaltyForBooking(
      ride({ passengerId: 'passenger-2' }),
    );
    expect(entries.filter((entry) => entry.userId === 'driver-1')).toHaveLength(
      1,
    );
    expect(accounts.get('driver-1')).toMatchObject({
      balance: 1,
      type: WalletAccountType.POINTS,
    });
    expect(entries).toHaveLength(3);
  });

  it.each([
    { startedAt: null },
    { completedAt: null },
    { status: TripStatus.PENDING },
    { status: TripStatus.ACTIVE },
    { status: TripStatus.CANCELLED },
    { startedAt: new Date('invalid') },
    { completedAt: new Date('2026-09-16T21:00:00Z') },
  ])(
    'does not reward an expired, unfinished or invalid driver trip: %j',
    async (overrides) => {
      expect(
        await service.awardLoyaltyForCompletedTrip(trip(overrides)),
      ).toBeNull();
      expect(transaction).not.toHaveBeenCalled();
    },
  );

  it('credits another genuinely completed trip separately', async () => {
    await service.awardLoyaltyForCompletedTrip(trip());
    await service.awardLoyaltyForCompletedTrip(trip({ id: 'trip-2' }));
    expect(accounts.get('driver-1')?.balance).toBe(2);
  });
});
