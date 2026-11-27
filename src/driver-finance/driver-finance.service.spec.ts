import { DriverFinanceService } from './driver-finance.service';
import { Trip } from '../trips/entities/trip.entity';
import { TripPaymentMode } from '../payments/enums/trip-payment-mode.enum';
import { Booking } from '../bookings/entities/booking.entity';
import { WalletAccount } from '../wallet/entities/wallet-account.entity';

describe('driver finance API projections', () => {
  let service: DriverFinanceService;
  let trip: any,
    booking: any,
    account: any,
    debt: number,
    policyActive: boolean,
    creditAvailable: boolean,
    exceptionRow: any;
  beforeEach(() => {
    trip = {
      id: 'trip',
      driverId: 'driver',
      pricePerSeat: 1000,
      acceptedPaymentModes: ['cash', 'points'],
      isPrivate: false,
    };
    booking = {
      id: 'booking',
      tripId: 'trip',
      trip,
      passengerId: 'passenger',
      paymentAmount: 10000,
      paymentMode: 'points',
      status: 'accepted',
    };
    account = {
      balance: 10,
      withdrawableBalance: 10,
      reservedCashCommissionBalance: 6,
      withdrawalsBlocked: false,
    };
    debt = 0;
    policyActive = true;
    creditAvailable = false;
    exceptionRow = null;
    const db = {
      getRepository: (entity: any) => ({
        findOneBy: async () =>
          entity === Trip ? trip : entity === WalletAccount ? account : null,
        findOne: async () => (entity === Booking ? booking : null),
        existsBy: async () => false,
      }),
      query: async (sql: string) =>
        sql.includes('COALESCE(SUM')
          ? [
              {
                debt,
                enabled: policyActive,
                creditAvailable,
                creditUsed: creditAvailable ? 1 : 6,
                creditPaid: creditAvailable ? 0 : 6,
                debtAmount: debt * 10,
              },
            ]
          : sql.includes('FROM users u') && exceptionRow ? [exceptionRow] : [],
    };
    service = new DriverFinanceService(
      db as any,
      { convertPointsToMoney: () => 10 } as any,
      { getPremiumOverview: async () => ({ isActive: true }) } as any,
    );
  });
  it('does not expose driver wallet amounts to a passenger', async () => {
    debt = 26;
    expect(await service.tripOptions('passenger', 'trip')).toEqual({
      acceptedPaymentModes: ['cash', 'points'],
      availablePaymentModes: ['points'],
      commissionRate: 0.05,
      cashUnavailableReason: expect.any(String),
    });
  });

  it('prices a new 10000 CDF cash trip commission at 50 tokens, not 20', async () => {
    trip.pricePerSeat = 10000;
    account.balance = 49;
    account.reservedCashCommissionBalance = 0;
    expect(
      (await service.tripOptions('passenger', 'trip')).availablePaymentModes,
    ).not.toContain('cash');
    account.balance = 50;
    expect(
      (await service.tripOptions('passenger', 'trip')).availablePaymentModes,
    ).toContain('cash');
    debt = 0.01;
    expect(
      (await service.tripOptions('passenger', 'trip')).availablePaymentModes,
    ).not.toContain('cash');
    expect((await service.summary('driver')).cash).toMatchObject({
      moneyPerToken: 10,
      debtLimitTokens: 0,
      debtAmount: 0.1,
    });
  });
  it('requires tokens for all seats, not only one passenger', async () => {
    account.reservedCashCommissionBalance = 0;
    expect(
      (await service.tripOptions('passenger', 'trip', 2)).availablePaymentModes,
    ).toContain('cash');
    expect(
      (await service.tripOptions('passenger', 'trip', 3)).availablePaymentModes,
    ).not.toContain('cash');
    await expect(service.tripOptions('passenger', 'trip', 0)).rejects.toThrow();
  });
  it('never renews the credit after repayment; any remaining debt blocks a new cash trip', async () => {
    debt = 20;
    account.balance = 1000;
    account.reservedCashCommissionBalance = 0;
    expect((await service.summary('driver')).cash).toMatchObject({
      enabled: false,
      availableCreditTokens: 0,
      creditAllowance: { eligible: false, remainingTrips: 0 },
    });
    debt = 0;
    expect((await service.summary('driver')).cash.enabled).toBe(true);
    account.balance = 0;
    expect((await service.summary('driver')).cash.enabled).toBe(false);
  });
  it('does not bypass payment eligibility when deferred collection is inactive', async () => {
    policyActive = false;
    debt = 26;
    expect(
      (await service.tripOptions('passenger', 'trip')).availablePaymentModes,
    ).not.toContain('cash');
  });
  it('preserves the accepted mode even if the trip or wallet changed later', async () => {
    booking.paymentMode = 'cash';
    trip.acceptedPaymentModes = ['points'];
    account.withdrawableBalance = 0;
    expect(
      (await service.bookingOptions('passenger', 'booking'))
        .availablePaymentModes,
    ).toContain('cash');
  });
  it('includes bonus-only funds in cash eligibility without exposing the driver balance', async () => {
    account.balance = 50;
    account.withdrawableBalance = 0;
    account.reservedCashCommissionBalance = 5;
    expect(
      (await service.tripOptions('passenger', 'trip', 9)).availablePaymentModes,
    ).toContain('cash');
    account.reservedCashCommissionBalance = 30;
    expect(
      (await service.tripOptions('passenger', 'trip', 10))
        .availablePaymentModes,
    ).not.toContain('cash');
  });
  it.each(['electronic', 'points'])(
    'offers full cash after arrival over %s without changing publication or mixed payment',
    async (mode) => {
      trip.acceptedPaymentModes = [mode];
      booking.paymentMode = mode;
      booking.status = 'completed';
      booking.droppedOff = true;
      booking.paymentStatus = 'pending';
      booking.paymentCurrency = 'CDF';
      booking.cashCommissionTokenValue = 10;
      account.balance = 100;
      account.reservedCashCommissionBalance = 0;
      const options = await service.bookingOptions('passenger', 'booking');
      expect(options).toMatchObject({
        acceptedPaymentModes: [mode],
        availablePaymentModes: [mode, 'cash'],
        cashFallbackAvailable: true,
        mixedCashSupported: false,
      });
      expect(trip.acceptedPaymentModes).toEqual([mode]);
      expect(
        (await service.tripOptions('passenger', 'trip')).availablePaymentModes,
      ).toEqual([mode]);
      expect(options).not.toHaveProperty('availableTokens');
    },
  );
  it('does not offer the arrival exception before arrival, after settlement or with insufficient cash eligibility', async () => {
    trip.acceptedPaymentModes = ['points'];
    account.balance = 100;
    account.reservedCashCommissionBalance = 0;
    for (const patch of [
      { status: 'accepted' },
      { droppedOff: false },
      { paymentStatus: 'succeeded' },
      { cashReceivedAt: new Date() },
      { mixedPaymentAt: new Date() },
      { paymentAmount: 0 },
      { status: 'cancelled' },
    ]) {
      Object.assign(
        booking,
        {
          status: 'completed',
          droppedOff: true,
          paymentStatus: 'pending',
          cashReceivedAt: null,
          mixedPaymentAt: null,
          paymentAmount: 10000,
        },
        patch,
      );
      const options = await service.bookingOptions('passenger', 'booking');
      expect(options.cashFallbackAvailable).toBe(false);
      expect(options.availablePaymentModes).not.toContain('cash');
    }
    Object.assign(booking, { status: 'completed', droppedOff: true });
    account.balance = 0;
    const unavailable = await service.bookingOptions('passenger', 'booking');
    expect(unavailable.cashFallbackAvailable).toBe(false);
    expect(unavailable.availablePaymentModes).not.toContain('cash');
    expect(unavailable.cashUnavailableReason).toEqual(expect.any(String));
  });
  it('enforces booking ownership and private-trip visibility', async () => {
    await expect(
      service.bookingOptions('stranger', 'booking'),
    ).rejects.toThrow();
    trip.isPrivate = true;
    await expect(service.tripOptions('stranger', 'trip')).rejects.toThrow();
    await expect(service.tripOptions('driver', 'trip')).resolves.toBeDefined();
  });
  it('shows first warning before arrival but offers exceptional cash only after actual dropoff', async () => {
    exceptionRow = { active: true, pending: false, occurrence: 1 };
    Object.assign(booking, { paymentCurrency: 'CDF', paymentStatus: 'pending' });
    trip.acceptedPaymentModes = ['points'];
    const before = await service.bookingOptions('driver', 'booking');
    expect(before.cashException).toMatchObject({ occurrence: 1, penaltyAmount: 0 });
    expect(before.availablePaymentModes).not.toContain('cash');
    Object.assign(booking, { status: 'completed', droppedOff: true });
    const after = await service.bookingOptions('passenger', 'booking');
    expect(after.cashFallbackAvailable).toBe(true);
    expect(after.availablePaymentModes).toContain('cash');
    expect(after.cashException).not.toHaveProperty('occurrence');
    expect(after.cashException).not.toHaveProperty('penaltyAmount');
    expect((await service.tripOptions('passenger', 'trip')).availablePaymentModes).not.toContain('cash');
  });
  it('retains the pending offence after switching cash, but never overrides an administrative block', async () => {
    exceptionRow = { active: true, pending: true, occurrence: 4 };
    Object.assign(booking, { paymentMode: 'cash', paymentCurrency: 'CDF', status: 'completed', droppedOff: true });
    expect((await service.bookingOptions('driver', 'booking')).cashException).toMatchObject({ penaltyAmount: 3000, suspensionAfterRide: true });
    account.withdrawalsBlocked = true; booking.paymentMode = 'points';
    const blocked = await service.bookingOptions('driver', 'booking');
    expect(blocked.cashException).toBeUndefined(); expect(blocked.cashFallbackAvailable).toBe(false);
  });
  it('exposes the server offer and permits cash without funds, without erasing existing debt', async () => {
    creditAvailable = true;
    account.balance = 0;
    account.reservedCashCommissionBalance = 0;
    debt = 30;
    const summary = await service.summary('driver');
    expect(summary.cashCommissionRate).toBe(0.05);
    expect(summary.commissionRate).toBe(0.05);
    expect(summary.cash).toMatchObject({
      enabled: true,
      debtTokens: 30,
      creditAllowance: {
        eligible: true,
        remainingTrips: 5,
        completedTrips: 0,
        reservedTrips: 1,
        tripLimit: 6,
        oneTime: true,
      },
    });
    expect(
      (await service.tripOptions('passenger', 'trip', 100))
        .availablePaymentModes,
    ).toContain('cash');
    account.withdrawalsBlocked = true;
    expect(
      (await service.summary('driver')).cash.creditAllowance.eligible,
    ).toBe(false);
    expect(
      (await service.tripOptions('passenger', 'trip')).availablePaymentModes,
    ).not.toContain('cash');
  });
});
