import { DriverSettlementsService } from './driver-settlements.service';
import { BookingPaymentStatus, BookingStatus } from '../bookings/entities/booking.entity';
import { TripPaymentMode } from '../payments/enums/trip-payment-mode.enum';
import { DriverEarningStatus } from './entities/driver-earning.entity';

function fixture() {
  const trip = { id: 'trip', driverId: 'driver', pricePerSeat: 3000, isFree: false };
  const booking: any = { id: 'booking', tripId: 'trip', trip, status: BookingStatus.COMPLETED,
    droppedOff: true, numberOfSeats: 1, paymentMode: TripPaymentMode.CASH,
    paymentStatus: BookingPaymentStatus.NOT_REQUIRED, paymentAmount: 1200, grossPaymentAmount: 3000,
    zwangaSubsidyAmount: 1800, firstTripSubsidyApplied: true, cashReceivedAt: null, cashReceivedAmount: null };
  const bookings = [booking];
  const earnings: any[] = [{ bookingId: 'booking', netAmount: 1800, status: DriverEarningStatus.AVAILABLE }];
  const send = jest.fn(async () => undefined);
  const service: DriverSettlementsService = Object.assign(Object.create(DriverSettlementsService.prototype), {
    tripRepository: { findOne: jest.fn(async () => trip) },
    bookingRepository: { find: jest.fn(async () => bookings), findOne: jest.fn(async () => booking) },
    earningRepository: { find: jest.fn(async () => earnings) },
    DEFAULT_CURRENCY: 'CDF', DEFAULT_COMMISSION_RATE: 0.05,
    configService: { get: jest.fn(() => undefined) }, notificationService: { sendNotificationToUser: send },
    logger: { error: jest.fn() },
  });
  return { service, booking, bookings, earnings, send };
}

describe('cash collected versus outstanding in booking, trip and notification summaries', () => {
  it('moves a confirmed receipt out of outstanding cash without changing total or platform earnings', async () => {
    const f = fixture();
    expect(await f.service.getTripRevenueSummary('driver', 'trip')).toMatchObject({
      cashReceivedAmount: 0, cashToCollectAmount: 1200, confirmedAmount: 1800, totalExpectedAmount: 3000,
    });
    Object.assign(f.booking, { cashReceivedAt: new Date(), cashReceivedAmount: '1200.00' });
    for (const summary of [await f.service.getTripRevenueSummary('driver', 'trip'),
      await f.service.getBookingRevenueSummary('driver', 'booking')]) {
      expect(summary).toMatchObject({ cashReceivedAmount: 1200, cashToCollectAmount: 0,
        confirmedAmount: 1800, creditPendingAmount: 0, totalExpectedAmount: 3000 });
    }
    expect(f.booking.paymentStatus).toBe(BookingPaymentStatus.NOT_REQUIRED);
    expect(f.earnings).toHaveLength(1);
  });

  it('aggregates received and outstanding cash across passengers without double counting', async () => {
    const f = fixture();
    Object.assign(f.booking, { cashReceivedAt: new Date(), cashReceivedAmount: 1200 });
    f.bookings.push({ ...f.booking, id: 'other', cashReceivedAt: null, cashReceivedAmount: null,
      firstTripSubsidyApplied: false, zwangaSubsidyAmount: 0, paymentAmount: 500, grossPaymentAmount: 500 });
    expect(await f.service.getTripRevenueSummary('driver', 'trip')).toMatchObject({
      cashReceivedAmount: 1200, cashToCollectAmount: 500, confirmedAmount: 1800, totalExpectedAmount: 3500,
    });
  });

  it('preserves a mixed token/cash receipt and never treats its tokens as additional cash', async () => {
    const f = fixture();
    Object.assign(f.booking, { firstTripSubsidyApplied: false, zwangaSubsidyAmount: 0,
      pointsPaidAmount: 1800, mixedPaymentAt: new Date(), cashReceivedAt: new Date(), cashReceivedAmount: 1200 });
    expect(await f.service.getBookingRevenueSummary('driver', 'booking')).toMatchObject({
      cashReceivedAmount: 1200, cashToCollectAmount: 0, confirmedAmount: 1800, totalExpectedAmount: 3000,
    });
  });

  it.each([null, undefined, -1, NaN, Infinity, 'invalid'])('does not invent received cash from invalid receipt amount %s', async value => {
    const f = fixture(); Object.assign(f.booking, { cashReceivedAt: new Date(), cashReceivedAmount: value });
    expect(await f.service.getTripRevenueSummary('driver', 'trip')).toMatchObject({
      cashReceivedAmount: 0, cashToCollectAmount: 1200, totalExpectedAmount: 3000,
    });
  });

  it('requires a confirmation, bounds malformed excess and preserves a partial remainder', async () => {
    const f = fixture(); f.booking.cashReceivedAmount = 1200;
    expect((await f.service.getTripRevenueSummary('driver', 'trip')).cashReceivedAmount).toBe(0);
    f.booking.cashReceivedAt = new Date(); f.booking.cashReceivedAmount = 500;
    expect(await f.service.getTripRevenueSummary('driver', 'trip')).toMatchObject({ cashReceivedAmount: 500, cashToCollectAmount: 700, totalExpectedAmount: 3000 });
    f.booking.cashReceivedAmount = 9000;
    expect(await f.service.getTripRevenueSummary('driver', 'trip')).toMatchObject({ cashReceivedAmount: 1200, cashToCollectAmount: 0, totalExpectedAmount: 3000 });
    f.booking.status = BookingStatus.CANCELLED;
    expect(await f.service.getTripRevenueSummary('driver', 'trip')).toMatchObject({ cashReceivedAmount: 0, cashToCollectAmount: 0, totalExpectedAmount: 0 });
  });

  it('sends the same received/due amounts in notification data and readable text', async () => {
    const f = fixture(); Object.assign(f.booking, { cashReceivedAt: new Date(), cashReceivedAmount: 1200 });
    const summary = await f.service.notifyDriverTripRevenue('driver', 'trip');
    expect(summary).toMatchObject({ cashReceivedAmount: 1200, cashToCollectAmount: 0 });
    expect(f.send).toHaveBeenCalledTimes(1);
    const [, , text, data] = f.send.mock.calls[0] as unknown as [string, string, string, any];
    expect(data).toMatchObject({ cashReceivedAmount: 1200, cashToCollectAmount: 0, confirmedAmount: 1800 });
    expect(text).toContain('reçus du passager en cash');
    expect(text).not.toContain('à recevoir');
  });
});
