import { activeBookingWhere, activeTripWhere } from './activity-read-policy';
import { BookingPaymentStatus, BookingStatus } from '../bookings/entities/booking.entity';
import { TripStatus } from '../trips/entities/trip.entity';
import { FindOperator } from 'typeorm';

const now = Date.parse('2026-09-17T12:00:00Z');
describe('activity reads without loading all historical rides', () => {
  it('scopes every passenger branch and retains unfinished bookings, recent arrivals and pending transactions', () => {
    const clauses = activeBookingWhere('passenger', now);
    expect(clauses.every(clause => clause.passengerId === 'passenger')).toBe(true);
    expect((clauses[0].status as FindOperator<BookingStatus>).value).toEqual([
      BookingStatus.PENDING, BookingStatus.ACCEPTED, BookingStatus.NO_SHOW, BookingStatus.BOARDING_UNCERTAIN,
    ]);
    expect((clauses[1].updatedAt as FindOperator<Date>).value).toEqual(new Date(now - 48 * 3600000));
    expect((clauses[2].droppedOffAt as FindOperator<Date>).value).toEqual(new Date(now - 48 * 3600000));
    expect(clauses[3].paymentStatus).toBe(BookingPaymentStatus.INITIATED);
  });

  it('retains every active/future driver trip and the entire 36-hour payment notice window', () => {
    const clauses = activeTripWhere('driver', now);
    expect(clauses.every(clause => clause.driverId === 'driver')).toBe(true);
    expect((clauses[0].status as FindOperator<TripStatus>).value).toEqual([TripStatus.PENDING, TripStatus.ACTIVE]);
    expect((clauses[1].completedAt as FindOperator<Date>).value).toEqual(new Date(now - 48 * 3600000));
    expect((clauses[2].departureDate as FindOperator<Date>).value).toEqual(new Date(now - 48 * 3600000));
  });
});
