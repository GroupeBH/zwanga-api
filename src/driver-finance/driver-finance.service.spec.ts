import { DriverFinanceService } from './driver-finance.service';
import { Trip } from '../trips/entities/trip.entity';
import { Booking } from '../bookings/entities/booking.entity';
import { WalletAccount } from '../wallet/entities/wallet-account.entity';

describe('driver finance API projections', () => {
  let service: DriverFinanceService;
  let trip: any, booking: any, account: any, debt: number;
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
    const db = {
      getRepository: (entity: any) => ({
        findOneBy: async () =>
          entity === Trip ? trip : entity === WalletAccount ? account : null,
        findOne: async () => (entity === Booking ? booking : null),
        existsBy: async () => false,
      }),
      query: async () => [{ debt }],
    };
    service = new DriverFinanceService(
      db as any,
      { convertPointsToMoney: () => 100 } as any,
      {} as any,
    );
  });
  it('does not expose driver wallet amounts to a passenger', async () => {
    debt = 1;
    expect(await service.tripOptions('passenger', 'trip')).toEqual({
      acceptedPaymentModes: ['cash', 'points'],
      availablePaymentModes: ['points'],
      commissionRate: 0.05,
      cashUnavailableReason: expect.any(String),
    });
  });
  it('uses all seats and all free tokens, blocking new cash while debt remains', async () => {
    account.reservedCashCommissionBalance = 0;
    expect(
      (await service.tripOptions('passenger', 'trip', 2)).availablePaymentModes,
    ).toContain('cash');
    expect(
      (await service.tripOptions('passenger', 'trip', 8)).availablePaymentModes,
    ).not.toContain('cash');
    debt = 0.01;
    expect(
      (await service.tripOptions('passenger', 'trip')).availablePaymentModes,
    ).not.toContain('cash');
    await expect(service.tripOptions('passenger', 'trip', 0)).rejects.toThrow();
  });
  it('allows exactly 25 tokens of new debt, but no further cash once any debt exists', async () => {
    account.balance = 0;
    account.withdrawableBalance = 0;
    account.reservedCashCommissionBalance = 0;
    expect((await service.tripOptions('passenger', 'trip', 5)).availablePaymentModes).toContain('cash');
    expect((await service.tripOptions('passenger', 'trip', 6)).availablePaymentModes).not.toContain('cash');
    debt = 0.01;
    expect((await service.tripOptions('passenger', 'trip')).availablePaymentModes).not.toContain('cash');
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
    account.balance = 50; account.withdrawableBalance = 0;
    account.reservedCashCommissionBalance = 5;
    expect((await service.tripOptions('passenger', 'trip', 10)).availablePaymentModes).toContain('cash');
    account.reservedCashCommissionBalance = 30;
    expect((await service.tripOptions('passenger', 'trip', 10)).availablePaymentModes).not.toContain('cash');
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
