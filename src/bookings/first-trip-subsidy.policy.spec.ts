import {
  cappedFirstTripFare,
  FIRST_TRIP_SUBSIDY_CAP_CDF,
} from './first-trip-subsidy.policy';
import { BookingsService } from './bookings.service';
import { BookingPaymentStatus, BookingStatus } from './entities/booking.entity';
import { assertNoSubsidyPayoutHold } from '../driver-settlements/subsidy-payout-guard';

describe('first-trip subsidy ceiling', () => {
  it.each([
    [2500, 1000, 1500],
    [12500, 5000, 7500],
    [20000, 12500, 7500],
    [40000000, 39992500, 7500],
  ])('caps a gross fare of %i CDF', (gross, passenger, subsidy) => {
    expect(cappedFirstTripFare(gross, 0.4)).toEqual({
      passengerAmount: passenger,
      subsidyAmount: subsidy,
    });
    expect(subsidy).toBeLessThanOrEqual(FIRST_TRIP_SUBSIDY_CAP_CDF);
  });
  it.each([NaN, Infinity, -1, 0])('rejects invalid gross %s', (gross) => {
    expect(() => cappedFirstTripFare(gross, 0.4)).toThrow();
  });
  function service() {
    const instance: any = Object.create(BookingsService.prototype);
    instance.FIRST_TRIP_SUBSIDY_RELEASED_STATUSES = [
      'cancelled',
      'rejected',
      'expired',
      'no_show',
      'boarding_uncertain',
    ];
    instance.configService = { get: () => undefined };
    instance.DEFAULT_FIRST_TRIP_SUBSIDY_ENABLED = false;
    instance.getFirstTripPassengerPaymentRate = () => 0.4;
    instance.canReserveFirstTripSubsidy = jest.fn().mockResolvedValue(true);
    return instance;
  }
  it('caps once for the whole booking, keeps exact fare after rate rounding and config changes', async () => {
    const instance = service();
    const b: any = {
      numberOfSeats: 4,
      status: BookingStatus.ACCEPTED,
      paymentStatus: BookingPaymentStatus.PENDING,
      paymentCurrency: 'CDF',
    };
    const trip = { pricePerSeat: 10_000_000 };
    await instance.applyFirstTripSubsidyPolicy(b, trip);
    expect(b.zwangaSubsidyAmount).toBe(7500);
    expect(b.paymentAmount).toBe(39992500);
    b.passengerPaymentRate = Number(b.passengerPaymentRate.toFixed(6));
    expect(instance.resolveBookingPaymentAmount(b, trip)).toBe(39992500);
    instance.getFirstTripPassengerPaymentRate = () => 0.9;
    await instance.applyFirstTripSubsidyPolicy(b, trip);
    expect(b.paymentAmount).toBe(39992500);
  });
  it('does not raise a legacy promised passenger fare', async () => {
    const instance = service();
    const b: any = {
      status: BookingStatus.ACCEPTED,
      firstTripSubsidyApplied: true,
      grossPaymentAmount: 20000,
      paymentAmount: 8000,
      zwangaSubsidyAmount: 12000,
      passengerPaymentRate: 0.4,
    };
    await instance.applyFirstTripSubsidyPolicy(b, { pricePerSeat: 20000 });
    expect(b.paymentAmount).toBe(8000);
    expect(b.zwangaSubsidyAmount).toBe(12000);
    expect(instance.canReserveFirstTripSubsidy).not.toHaveBeenCalled();
  });
  it('blocks withdrawal without deleting/repricing legacy earnings', async () => {
    const manager = { query: jest.fn().mockResolvedValue([{ '?column?': 1 }]) };
    await expect(
      assertNoSubsidyPayoutHold(manager, 'driver'),
    ).rejects.toMatchObject({
      response: { code: 'SUBSIDY_PAYOUT_REVIEW_REQUIRED' },
    });
    expect(manager.query).toHaveBeenCalledWith(
      expect.stringContaining('SELECT 1'),
      ['driver', 7500],
    );
  });
});
