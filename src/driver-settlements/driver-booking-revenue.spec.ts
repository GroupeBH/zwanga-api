import { DriverSettlementsService } from './driver-settlements.service';
import { BookingPaymentStatus, BookingStatus } from '../bookings/entities/booking.entity';
import { TripPaymentMode } from '../payments/enums/trip-payment-mode.enum';
import { DriverEarningStatus } from './entities/driver-earning.entity';

function fixture() {
  const booking: any = { id: 'booking', tripId: 'trip', passengerId: 'passenger',
    status: BookingStatus.COMPLETED, droppedOff: true, numberOfSeats: 2,
    paymentMode: TripPaymentMode.CASH, paymentStatus: BookingPaymentStatus.NOT_REQUIRED,
    paymentAmount: 2000, grossPaymentAmount: 5000, zwangaSubsidyAmount: 3000, firstTripSubsidyApplied: true,
    trip: { id: 'trip', driverId: 'driver', pricePerSeat: 90000, isFree: false } };
  const bookings = { findOne: jest.fn(async () => booking) };
  const earnings = { find: jest.fn(async () => [] as any[]) };
  const service: DriverSettlementsService = Object.assign(Object.create(DriverSettlementsService.prototype), {
    bookingRepository: bookings, earningRepository: earnings,
    DEFAULT_CURRENCY: 'CDF', DEFAULT_COMMISSION_RATE: 0.05,
    configService: { get: jest.fn(() => undefined) },
  });
  return { service, booking, bookings, earnings };
}

describe('driver revenue per confirmed dropoff', () => {
  it('reads only the owned reservation and its ledger, not the total for other passengers', async () => {
    const f = fixture();
    const summary = await f.service.getBookingRevenueSummary('driver', 'booking');
    expect(f.bookings.findOne).toHaveBeenCalledWith({ where: { id: 'booking', trip: { driverId: 'driver' } }, relations: ['trip'] });
    expect(f.earnings.find).toHaveBeenCalledWith({ where: { bookingId: 'booking', tripId: 'trip', driverId: 'driver' } });
    expect(summary).toMatchObject({ bookingId: 'booking', dropoffConfirmed: true,
      cashToCollectAmount: 2000, confirmedAmount: 0, creditPendingAmount: 3000, totalExpectedAmount: 5000 });
    expect(f.booking.paymentStatus).toBe(BookingPaymentStatus.NOT_REQUIRED);
  });
  it('uses persisted net earnings, never inventing credit from dropoff or payment status', async () => {
    const f = fixture();
    f.earnings.find.mockResolvedValue([{ bookingId: 'booking', netAmount: 3000, status: DriverEarningStatus.AVAILABLE }]);
    expect(await f.service.getBookingRevenueSummary('driver', 'booking')).toMatchObject({
      ledgerVerified: true, confirmedAmount: 3000, creditPendingAmount: 0, cashToCollectAmount: 2000, totalExpectedAmount: 5000,
    });
    f.booking.paymentMode = TripPaymentMode.ELECTRONIC;
    f.booking.paymentStatus = BookingPaymentStatus.SUCCEEDED;
    f.earnings.find.mockResolvedValue([{ bookingId: 'booking', netAmount: 4300, status: DriverEarningStatus.PAID }]);
    expect(await f.service.getBookingRevenueSummary('driver', 'booking')).toMatchObject({ confirmedAmount: 4300, totalExpectedAmount: 4300, cashToCollectAmount: 0 });
  });
  it.each([TripPaymentMode.ELECTRONIC, TripPaymentMode.POINTS])('separates unpaid %s from received earnings', async mode => {
    const f = fixture(); f.booking.paymentMode = mode; f.booking.paymentStatus = BookingPaymentStatus.PENDING;
    const summary = await f.service.getBookingRevenueSummary('driver', 'booking');
    expect(summary).toMatchObject({ confirmedAmount: 0, creditPendingAmount: 0, totalExpectedAmount: 4750, cashToCollectAmount: 0 });
    expect(mode === TripPaymentMode.POINTS ? summary.pointsPendingAmount : summary.electronicPendingAmount).toBe(4750);
    f.booking.paymentStatus = BookingPaymentStatus.SUCCEEDED;
    expect(await f.service.getBookingRevenueSummary('driver', 'booking')).toMatchObject({ confirmedAmount: 0, creditPendingAmount: 4750, pointsPendingAmount: 0, electronicPendingAmount: 0 });
  });
  it('keeps the adjusted interruption fare and never multiplies it by seats or reprices from the trip', async () => {
    const f = fixture();
    Object.assign(f.booking, { paymentAmount: 1500, grossPaymentAmount: 1500, interruptionFareLocked: true, firstTripSubsidyApplied: false });
    expect(await f.service.getBookingRevenueSummary('driver', 'booking')).toMatchObject({ cashToCollectAmount: 1500, totalExpectedAmount: 1500 });
  });
  it('a persisted zero fare stays free even if the trip price changed', async () => {
    const f = fixture();
    Object.assign(f.booking, { paymentAmount: 0, grossPaymentAmount: 0, firstTripSubsidyApplied: false });
    expect(await f.service.getBookingRevenueSummary('driver', 'booking')).toMatchObject({ dropoffConfirmed: true, totalExpectedAmount: 0 });
  });
  it('a local/manual declaration awaiting validation cannot report a gain', async () => {
    const f = fixture(); Object.assign(f.booking, { status: BookingStatus.ACCEPTED, droppedOff: false });
    expect(await f.service.getBookingRevenueSummary('driver', 'booking')).toMatchObject({ dropoffConfirmed: false, totalExpectedAmount: 0, confirmedAmount: 0 });
  });
  it('denies missing reservations and other drivers before reading their earnings', async () => {
    const f = fixture();
    f.bookings.findOne.mockResolvedValueOnce(null);
    await expect(f.service.getBookingRevenueSummary('driver', 'missing')).rejects.toThrow('introuvable');
    f.booking.trip.driverId = 'someone-else';
    await expect(f.service.getBookingRevenueSummary('driver', 'booking')).rejects.toThrow('introuvable');
    expect(f.earnings.find).not.toHaveBeenCalled();
  });
});
