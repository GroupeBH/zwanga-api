import { driverPaymentNotification } from './driver-payment-notification';
import { Booking, BookingPaymentStatus } from '../bookings/entities/booking.entity';
import { TripPaymentMode } from '../payments/enums/trip-payment-mode.enum';
import { TransactionalNotificationsSubscriber } from './transactional-notifications.subscriber';

const paid = { id: 'booking', tripId: 'trip', paymentMode: TripPaymentMode.POINTS,
  paymentStatus: BookingPaymentStatus.SUCCEEDED, paymentAmount: 800, paymentCurrency: 'CDF' } as Booking;
describe('confirmed driver payment receipts', () => {
  it.each([TripPaymentMode.POINTS, TripPaymentMode.ELECTRONIC])('uses the confirmed reduced amount for %s, never the original/gross fare', mode => {
    const notice = driverPaymentNotification({ ...paid, paymentMode: mode, grossPaymentAmount: 2000 } as Booking, 'driver');
    expect(notice?.data).toMatchObject({ amount: 800, driverId: 'driver', tripId: 'trip', paymentMode: mode });
    expect(notice?.eventKey).toBe('driver-payment:booking:paid');
    expect(notice?.body).not.toContain('2 000');
  });
  it.each([BookingPaymentStatus.FAILED, BookingPaymentStatus.INITIATED, BookingPaymentStatus.PENDING, BookingPaymentStatus.CANCELLED])('never calls an uncertain/failed %s payment received', paymentStatus => {
    expect(driverPaymentNotification({ ...paid, paymentStatus }, 'driver')).toBeNull();
  });
  it('does not re-enqueue already-paid rows or announce cash merely selected', () => {
    expect(driverPaymentNotification(paid, 'driver', paid)).toBeNull();
    expect(driverPaymentNotification({ ...paid, paymentMode: TripPaymentMode.CASH }, 'driver')).toBeNull();
    expect(driverPaymentNotification({ ...paid, paymentAmount: NaN }, 'driver')).toBeNull();
    expect(driverPaymentNotification({ ...paid, paymentAmount: 0 }, 'driver')).toBeNull();
  });
  it('separates received tokens from cash still owed', () => {
    const split = { ...paid, paymentMode: TripPaymentMode.CASH, paymentStatus: BookingPaymentStatus.NOT_REQUIRED,
      mixedTokenAmount: 580, mixedPaymentAt: new Date(), paymentAmount: 3920 } as Booking;
    const notice = driverPaymentNotification(split, 'driver');
    expect(notice?.data).toMatchObject({ amount: 580, cashRemainder: 3920, partial: true, paymentMode: 'points' });
    expect(notice?.data.receiptKey).toBe('booking-payment:booking:tokens');
    expect(driverPaymentNotification(split, 'driver', split)).toBeNull();
  });
  it('requires a transaction before writing new payment receipts but leaves boarding/status saves unchanged', () => {
    const subscriber = new TransactionalNotificationsSubscriber({ subscribers: [] } as any);
    const event = { metadata: { target: Booking }, entity: paid, databaseEntity: { ...paid, paymentStatus: 'pending' },
      queryRunner: { isTransactionActive: false } };
    expect(() => subscriber.beforeUpdate(event as any)).toThrow('transactional save');
    expect(() => subscriber.beforeUpdate({ ...event, entity: { status: 'accepted' } } as any)).not.toThrow();
    expect(() => subscriber.beforeUpdate({ ...event, queryRunner: { isTransactionActive: true } } as any)).not.toThrow();
  });
});
