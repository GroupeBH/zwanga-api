import { Booking, BookingStatus, BookingPaymentStatus } from '../bookings/entities/booking.entity';
import { Trip, TripStatus } from '../trips/entities/trip.entity';
import { TripPaymentMode } from '../payments/enums/trip-payment-mode.enum';
import { DriverEarning, DriverEarningStatus } from './entities/driver-earning.entity';
import { DriverSettlementsService } from './driver-settlements.service';

function fixture() {
  const trip = { id: 'trip', driverId: 'driver', pricePerSeat: 5000, isFree: false, status: TripStatus.COMPLETED };
  const booking = {
    id: 'booking', tripId: trip.id, passengerId: 'passenger', trip, numberOfSeats: 1,
    status: BookingStatus.COMPLETED, paymentMode: TripPaymentMode.CASH,
    paymentStatus: BookingPaymentStatus.NOT_REQUIRED, paidAt: null,
    grossPaymentAmount: 5000, paymentAmount: 2000, passengerPaymentRate: 0.4,
    firstTripSubsidyApplied: true, zwangaSubsidyAmount: 3000, paymentCurrency: 'CDF',
  };
  const records: DriverEarning[] = [];
  const manager = {
    findOne: jest.fn(async (entity) => {
      if (entity === Booking) return booking;
      if (entity === Trip) return trip;
      if (entity === DriverEarning) return records[0] ?? null;
      return null;
    }),
    create: jest.fn((_entity, data) => data),
    save: jest.fn(async (data) => { const saved = { id: 'earning', ...data }; records.push(saved); return saved; }),
  };
  // Model PostgreSQL's per-booking serialisation; also assert the actual lock request below.
  let queue = Promise.resolve();
  const dataSource = { transaction: jest.fn((work) => {
    const next = queue.then(() => work(manager));
    queue = next.catch(() => undefined);
    return next;
  }) };
  const earnings = { find: jest.fn(async () => records) };
  const notifications = { sendNotificationToUser: jest.fn(async () => {
    expect(records.length).toBe(1);
  }) };
  const service = new DriverSettlementsService(
    earnings as any, {} as any, {} as any, {} as any,
    { find: jest.fn(async () => [booking]) } as any,
    { findOne: jest.fn(async () => trip) } as any,
    { get: jest.fn((key) => key === 'ZWANGA_COMMISSION_RATE' ? '0.05' : undefined) } as any,
    {} as any, dataSource as any, notifications as any,
  );
  return { service, booking, trip, manager, dataSource, records, notifications, earnings };
}

describe('Cash subsidy credit and authoritative trip summary', () => {
  it('reports a missing 3000 FC credit as pending, with 2000 FC owed in cash', async () => {
    const f = fixture();
    expect(await f.service.getTripRevenueSummary('driver', 'trip')).toMatchObject({
      ledgerVerified: true, grossTripAmount: 5000, confirmedAmount: 0,
      creditPendingAmount: 3000, cashToCollectAmount: 2000, totalExpectedAmount: 5000,
    });
    expect(f.earnings.find).toHaveBeenCalledWith({ where: { driverId: 'driver', tripId: 'trip' } });
  });

  it('credits the persisted subsidy once on concurrent/repeated arrival and recovery, never debits cash', async () => {
    const f = fixture();
    const staleBooking = { ...f.booking, zwangaSubsidyAmount: 800 } as Booking;
    await Promise.all([
      f.service.recordCompletedBookingEarning(staleBooking),
      f.service.recordCompletedBookingEarning(staleBooking),
    ]);
    expect(f.manager.findOne).toHaveBeenCalledWith(Booking, {
      where: { id: 'booking' }, lock: { mode: 'pessimistic_write' },
    });
    expect(f.records).toHaveLength(1);
    expect(f.records[0]).toMatchObject({
      grossAmount: 3000, netAmount: 3000, commissionRate: 0, paymentMode: 'cash', status: 'available',
    });
    expect(f.notifications.sendNotificationToUser).toHaveBeenCalledTimes(1);
    expect(f.booking.paymentAmount).toBe(2000);
    expect(f.booking.paidAt).toBeNull();
    expect(f.booking.paymentStatus).toBe('not_required');
    expect(await f.service.getTripRevenueSummary('driver', 'trip')).toMatchObject({
      confirmedAmount: 3000, creditPendingAmount: 0, cashToCollectAmount: 2000, totalExpectedAmount: 5000,
    });
  });

  it('does not show or notify a gain if the database rejects the insertion', async () => {
    const f = fixture();
    f.manager.save.mockRejectedValueOnce(new Error('CHK_driver_earnings_payment_mode'));
    await expect(f.service.recordCompletedBookingEarning(f.booking as Booking)).rejects.toThrow('CHK_driver_earnings_payment_mode');
    expect(f.records).toHaveLength(0);
    expect(f.notifications.sendNotificationToUser).not.toHaveBeenCalled();
    expect(await f.service.getTripRevenueSummary('driver', 'trip')).toMatchObject({ confirmedAmount: 0, creditPendingAmount: 3000 });
  });

  it.each([BookingStatus.CANCELLED, BookingStatus.NO_SHOW, BookingStatus.EXPIRED, BookingStatus.ACCEPTED])(
    'does not credit a booking that has not completed its ride (%s)', async status => {
      const f = fixture(); f.booking.status = status;
      expect(await f.service.recordCompletedBookingEarning(f.booking as Booking)).toBeNull();
      expect(f.manager.save).not.toHaveBeenCalled();
    },
  );

  it('does not recreate or advertise a cancelled earning', async () => {
    const f = fixture();
    f.records.push({ bookingId: 'booking', netAmount: 3000, status: DriverEarningStatus.CANCELLED } as DriverEarning);
    await f.service.recordCompletedBookingEarning(f.booking as Booking);
    expect(f.manager.save).not.toHaveBeenCalled();
    expect(f.notifications.sendNotificationToUser).not.toHaveBeenCalled();
    expect(await f.service.getTripRevenueSummary('driver', 'trip')).toMatchObject({ confirmedAmount: 0, creditPendingAmount: 0 });
  });

  it('does not recalculate an inconsistent persisted fare', async () => {
    const f = fixture(); f.booking.zwangaSubsidyAmount = 800;
    await expect(f.service.recordCompletedBookingEarning(f.booking as Booking)).rejects.toThrow('CASH_SUBSIDY_FARE_INCONSISTENT');
    expect(f.manager.save).not.toHaveBeenCalled();
  });

  it('does not credit an ordinary cash trip or a free trip', async () => {
    const f = fixture(); f.booking.firstTripSubsidyApplied = false; f.booking.zwangaSubsidyAmount = 0;
    expect(await f.service.recordCompletedBookingEarning(f.booking as Booking)).toBeNull();
    f.booking.grossPaymentAmount = 0; f.booking.paymentAmount = 0; f.trip.isFree = true;
    expect(await f.service.recordCompletedBookingEarning(f.booking as Booking)).toBeNull();
    expect(f.manager.save).not.toHaveBeenCalled();
  });

  it('keeps electronically paid but uncredited amounts pending until a ledger entry exists', async () => {
    const f = fixture();
    f.booking.paymentMode = TripPaymentMode.ELECTRONIC;
    f.booking.paymentStatus = BookingPaymentStatus.SUCCEEDED;
    expect(await f.service.getTripRevenueSummary('driver', 'trip')).toMatchObject({
      confirmedAmount: 0, creditPendingAmount: 4750, electronicPendingAmount: 0, cashToCollectAmount: 0,
    });
  });
});
