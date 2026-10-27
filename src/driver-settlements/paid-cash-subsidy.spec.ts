import { DriverSettlementsService } from './driver-settlements.service';
import {
  DriverEarning,
  DriverEarningStatus,
} from './entities/driver-earning.entity';
import {
  Booking,
  BookingPaymentStatus,
  BookingStatus,
} from '../bookings/entities/booking.entity';
import { Trip, TripStatus } from '../trips/entities/trip.entity';
import { TripPaymentMode } from '../payments/enums/trip-payment-mode.enum';

function fixture(mode = TripPaymentMode.POINTS, policy = 2) {
  const booking = {
    id: 'booking',
    tripId: 'trip',
    passengerId: 'passenger',
    status: BookingStatus.COMPLETED,
    paymentMode: mode,
    paymentStatus: BookingPaymentStatus.SUCCEEDED,
    grossPaymentAmount: 2000,
    paymentAmount: 800,
    zwangaSubsidyAmount: 1200,
    firstTripSubsidyApplied: true,
    paymentCurrency: 'CDF',
    cashCommissionPolicyVersion: policy,
    trip: { id: 'trip', driverId: 'driver', status: TripStatus.ACTIVE },
  } as Booking;
  let existing = {
    id: 'earning',
    bookingId: booking.id,
    tripId: booking.tripId,
    passengerId: booking.passengerId,
    driverId: 'driver',
    paymentMode: TripPaymentMode.CASH,
    currency: 'CDF',
    grossAmount: 1200,
    commissionRate: 0,
    commissionAmount: 0,
    netAmount: 1200,
    status: DriverEarningStatus.AVAILABLE,
    paidAt: null,
    availableAt: new Date('2026-01-01'),
  } as DriverEarning;
  const manager = {
    findOne: jest.fn((target: unknown) =>
      Promise.resolve(
        target === Booking
          ? booking
          : target === Trip
            ? booking.trip
            : existing,
      ),
    ),
    create: jest.fn((_entity: unknown, value: DriverEarning) => value),
    save: jest.fn((value: DriverEarning) => {
      existing = value;
      return Promise.resolve(value);
    }),
  };
  const repository = { findOne: jest.fn(() => Promise.resolve(existing)) };
  const service = new DriverSettlementsService(
    repository as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { get: () => undefined } as never,
    {} as never,
    {
      transaction: (
        work: (m: typeof manager) => Promise<DriverEarning | null>,
      ) => work(manager),
    } as never,
    {} as never,
  );
  return { service, booking, manager, existing };
}

describe('previously credited cash subsidy followed by a confirmed passenger payment', () => {
  it.each([TripPaymentMode.POINTS, TripPaymentMode.ELECTRONIC])(
    'adds only the funded passenger net portion for %s',
    async (mode) => {
      const f = fixture(mode);
      const result = await f.service.recordCompletedBookingEarningWithManager(
        f.manager as never,
        f.booking,
      );
      expect(result).toMatchObject({
        id: 'earning',
        grossAmount: 2000,
        commissionAmount: 40,
        netAmount: 1960,
        commissionRate: 0.05,
        paymentMode: mode,
        status: 'available',
        availableAt: f.existing.availableAt,
      });
      await f.service.recordCompletedBookingEarningWithManager(
        f.manager as never,
        f.booking,
      );
      expect(f.manager.save).toHaveBeenCalledTimes(1);
      expect(f.manager.findOne).toHaveBeenCalledWith(DriverEarning, {
        where: { bookingId: 'booking' },
        lock: { mode: 'pessimistic_write' },
      });
    },
  );

  it('preserves historical full-fare commission instead of applying the new policy retroactively', async () => {
    const f = fixture(TripPaymentMode.POINTS, 0);
    expect(
      await f.service.recordCompletedBookingEarningWithManager(
        f.manager as never,
        f.booking,
      ),
    ).toMatchObject({
      grossAmount: 2000,
      commissionAmount: 100,
      netAmount: 1900,
    });
  });

  it('uses the agreed reduced fare on an interrupted ride', async () => {
    const f = fixture();
    Object.assign(f.booking, {
      interruptionFareLocked: true,
      grossPaymentAmount: 1500,
      paymentAmount: 800,
      zwangaSubsidyAmount: 700,
    });
    Object.assign(f.existing, { grossAmount: 700, netAmount: 700 });
    expect(
      await f.service.recordCompletedBookingEarningWithManager(
        f.manager as never,
        f.booking,
      ),
    ).toMatchObject({
      grossAmount: 1500,
      commissionAmount: 40,
      netAmount: 1460,
    });
  });

  it('an electronic finalization re-reads and locks the booking before reconciling its subsidy', async () => {
    const f = fixture(TripPaymentMode.ELECTRONIC);
    const result = await f.service.recordCompletedBookingEarning({
      ...f.booking,
      grossPaymentAmount: 9999,
    });
    expect(result).toMatchObject({ id: 'earning', netAmount: 1960 });
    expect(f.manager.findOne.mock.calls[0]).toEqual([
      Booking,
      { where: { id: 'booking' }, lock: { mode: 'pessimistic_write' } },
    ]);
  });

  it.each([
    ['foreign passenger', {}, { passengerId: 'other' }],
    ['foreign driver', {}, { driverId: 'other' }],
    ['foreign trip', {}, { tripId: 'other' }],
    ['foreign booking', {}, { bookingId: 'other' }],
    ['currency mismatch', {}, { currency: 'USD' }],
    ['wrong existing amount', {}, { grossAmount: 1500, netAmount: 1500 }],
    ['wrong existing fee', {}, { commissionRate: 0.05 }],
    ['cancelled entry', {}, { status: DriverEarningStatus.CANCELLED }],
    ['paid entry', {}, { status: DriverEarningStatus.PAID }],
    ['recorded payout', {}, { paidAt: new Date() }],
    ['cash already received', { cashReceivedAt: new Date() }, {}],
    ['cash fallback selected', { tokenCashFallbackAt: new Date() }, {}],
    [
      'mixed payment',
      { mixedPaymentAt: new Date(), mixedTokenAmount: 100 },
      {},
    ],
    ['unbalanced fare', { grossPaymentAmount: 1000 }, {}],
    ['missing subsidy flag', { firstTripSubsidyApplied: false }, {}],
    ['ride not completed', { status: BookingStatus.ACCEPTED }, {}],
  ])(
    'keeps protection against a genuine inconsistency: %s',
    async (_name, patch, entry) => {
      const f = fixture();
      Object.assign(f.booking, patch);
      Object.assign(f.existing, entry);
      await expect(
        f.service.recordCompletedBookingEarningWithManager(
          f.manager as never,
          f.booking,
        ),
      ).rejects.toMatchObject({
        response: { code: 'DRIVER_EARNING_RECONCILIATION_REQUIRED' },
      });
      expect(f.manager.save).not.toHaveBeenCalled();
    },
  );
});
