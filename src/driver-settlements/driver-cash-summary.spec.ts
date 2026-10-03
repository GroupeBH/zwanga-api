import { sumConfirmedDriverCash } from './driver-cash-summary';
import { DriverSettlementsService } from './driver-settlements.service';
import { DriverEarningStatus } from './entities/driver-earning.entity';
import { DriverPayoutStatus } from './entities/driver-payout.entity';
import { TripPaymentMode } from '../payments/enums/trip-payment-mode.enum';

function aggregate(sum: string) {
  return {
    innerJoin: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getRawOne: jest.fn().mockResolvedValue({ sum }),
  };
}

describe('Informational driver cash receipts', () => {
  it('aggregates confirmed passenger receipts for the owner and currency, not fares or subsidies', async () => {
    const query = aggregate('12000.50');
    const bookings = { createQueryBuilder: jest.fn(() => query) };
    await expect(sumConfirmedDriverCash(bookings as any, 'driver-A', 'CDF')).resolves.toBe(12000.5);
    expect(bookings.createQueryBuilder).toHaveBeenCalledTimes(1);
    expect(query.innerJoin).toHaveBeenCalledWith('booking.trip', 'trip');
    expect(query.select).toHaveBeenCalledWith('COALESCE(SUM(booking.cashReceivedAmount), 0)', 'sum');
    expect(query.where).toHaveBeenCalledWith('trip.driverId = :driverId', { driverId: 'driver-A' });
    expect(query.andWhere.mock.calls).toEqual([
      ['booking.cashReceivedByDriverId = :driverId', { driverId: 'driver-A' }],
      ['booking.paymentMode = :paymentMode', { paymentMode: TripPaymentMode.CASH }],
      ['booking.paymentCurrency = :currency', { currency: 'CDF' }],
      ['booking.cashReceivedAt IS NOT NULL'],
    ]);
  });

  it('returns zero for no receipts, but propagates failures instead of inventing a zero total', async () => {
    const query = aggregate('0');
    const bookings = { createQueryBuilder: () => query };
    await expect(sumConfirmedDriverCash(bookings as any, 'driver-A', 'CDF')).resolves.toBe(0);
    query.getRawOne.mockRejectedValueOnce(new Error('read failed'));
    await expect(sumConfirmedDriverCash(bookings as any, 'driver-A', 'CDF')).rejects.toThrow('read failed');
  });

  it.each([
    { earned: 12500, pending: 2000, paid: 4000, available: 6500 },
    { earned: 0, pending: 0, paid: 0, available: 0 },
  ])('keeps cash outside balances: %j', async ({ earned, pending, paid, available }) => {
    // The earnings ledger includes electronic/token income and the Zwanga subsidy.
    const earningsQuery = aggregate(String(earned));
    const cashQuery = aggregate('50000');
    const payouts = {
      exists: jest.fn().mockResolvedValue(false),
      createQueryBuilder: () => {
        const query = aggregate('0');
        query.andWhere.mockImplementation((_sql, { statuses }) => {
          const total = statuses.includes(DriverPayoutStatus.SUCCEEDED) ?
            paid + (statuses.includes(DriverPayoutStatus.PENDING) ? pending : 0) : pending;
          query.getRawOne.mockResolvedValue({ sum: String(total) });
          return query;
        });
        return query;
      },
    };
    const service = new DriverSettlementsService(
      { createQueryBuilder: () => earningsQuery } as any,
      payouts as any,
      { findOne: jest.fn().mockResolvedValue(null) } as any,
      { exists: jest.fn().mockResolvedValue(true) } as any,
      { createQueryBuilder: () => cashQuery } as any,
      {} as any,
      { get: jest.fn() } as any,
      {} as any, {} as any, {} as any,
    );
    await expect(service.getSummary('driver-A')).resolves.toMatchObject({
      availableBalance: available,
      pendingPayoutBalance: pending,
      paidBalance: paid,
      cashReceivedAmount: 50000,
      currency: 'CDF',
    });
    expect(earningsQuery.andWhere).toHaveBeenCalledWith('earning.status IN (:...statuses)', {
      statuses: [DriverEarningStatus.AVAILABLE],
    });
  });
});
