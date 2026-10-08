import { DriverFinanceService } from './driver-finance.service';
import { Trip } from '../trips/entities/trip.entity';
import { Booking } from '../bookings/entities/booking.entity';
import { WalletAccount } from '../wallet/entities/wallet-account.entity';

describe('driver finance API projections', () => {
  let service: DriverFinanceService;
  let trip: any,
    booking: any,
    account: any,
    debt: number,
    policyActive: boolean;
  beforeEach(() => {
    trip = {
      id: 'trip',
      driverId: 'driver',
      pricePerSeat: 10000,
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
    const db = {
      getRepository: (entity: any) => ({
        findOneBy: async () =>
          entity === Trip ? trip : entity === WalletAccount ? account : null,
        findOne: async () => (entity === Booking ? booking : null),
        existsBy: async () => false,
      }),
      query: async (sql: string) =>
        sql.includes('COALESCE(SUM') ? [{ debt, enabled: policyActive }] : [],
    };
    service = new DriverFinanceService(
      db as any,
      { convertPointsToMoney: () => 100 } as any,
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
  it('uses all seats and all free tokens, blocking cash above the aggregate debt limit', async () => {
    account.reservedCashCommissionBalance = 0;
    expect(
      (await service.tripOptions('passenger', 'trip', 2)).availablePaymentModes,
    ).toContain('cash');
    expect(
      (await service.tripOptions('passenger', 'trip', 8)).availablePaymentModes,
    ).not.toContain('cash');
    debt = 25.01;
    expect(
      (await service.tripOptions('passenger', 'trip')).availablePaymentModes,
    ).not.toContain('cash');
    await expect(service.tripOptions('passenger', 'trip', 0)).rejects.toThrow();
  });
  it('deducts existing debt from the remaining 25-token allowance', async () => {
    account.balance = 0;
    account.withdrawableBalance = 0;
    account.reservedCashCommissionBalance = 0;
    expect(
      (await service.tripOptions('passenger', 'trip', 5)).availablePaymentModes,
    ).toContain('cash');
    expect(
      (await service.tripOptions('passenger', 'trip', 6)).availablePaymentModes,
    ).not.toContain('cash');
    debt = 0.01;
    expect(
      (await service.tripOptions('passenger', 'trip')).availablePaymentModes,
    ).toContain('cash');
    expect(
      (await service.tripOptions('passenger', 'trip', 5)).availablePaymentModes,
    ).not.toContain('cash');
  });
  it.each([
    [20, 0, true],
    [20.01, 0, false],
    [25, 0, false],
    [25, 5, true],
    [25.01, 5, false],
  ])(
    'projects the cumulative ceiling with debt=%s and funds=%s',
    async (owed, funds, allowed) => {
      debt = owed as number;
      account.balance = funds;
      account.reservedCashCommissionBalance = 0;
      expect(
        (
          await service.tripOptions('passenger', 'trip')
        ).availablePaymentModes.includes('cash'),
      ).toBe(allowed);
    },
  );
  it('reports remaining credit rather than granting another 25 for every trip', async () => {
    debt = 20;
    account.balance = 0;
    account.reservedCashCommissionBalance = 0;
    expect((await service.summary('driver')).cash).toMatchObject({
      enabled: true,
      debtTokens: 20,
      availableCreditTokens: 5,
    });
    debt = 25;
    expect((await service.summary('driver')).cash).toMatchObject({
      enabled: false,
      availableCreditTokens: 0,
    });
    account.balance = 5;
    expect((await service.summary('driver')).cash.enabled).toBe(true);
    debt = 25.01;
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
      (await service.tripOptions('passenger', 'trip', 10))
        .availablePaymentModes,
    ).toContain('cash');
    account.reservedCashCommissionBalance = 30;
    expect(
      (await service.tripOptions('passenger', 'trip', 10))
        .availablePaymentModes,
    ).not.toContain('cash');
  });
  it('enforces booking ownership and private-trip visibility', async () => {
    await expect(
      service.bookingOptions('stranger', 'booking'),
    ).rejects.toThrow();
    trip.isPrivate = true;
    await expect(service.tripOptions('stranger', 'trip')).rejects.toThrow();
    await expect(service.tripOptions('driver', 'trip')).resolves.toBeDefined();
  });
});
