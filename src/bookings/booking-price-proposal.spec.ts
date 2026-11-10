import { Booking, BookingPaymentStatus, BookingStatus } from './entities/booking.entity';
import { Trip, TripStatus } from '../trips/entities/trip.entity';
import { acceptedBookingProposalTotal, validateBookingPriceProposal } from './booking-price-proposal';
import { BookingsService } from './bookings.service';
import { validate } from 'class-validator';
import { AcceptBookingDto, CreateBookingDto } from './dto/booking.dto';

describe('booking price proposals', () => {
  const trip = { pricePerSeat: 3500, isFree: false } as Trip;
  it.each([undefined, null])('keeps legacy bookings unchanged (%s)', value => {
    expect(validateBookingPriceProposal(value, trip, 1)).toBeNull();
    expect(acceptedBookingProposalTotal({ proposedPricePerSeat: value } as Booking)).toBeNull();
  });
  it('accepts a lower per-seat proposal without changing the public price', () => {
    expect(validateBookingPriceProposal(2500, trip, 2)).toBe(2500);
    expect(trip.pricePerSeat).toBe(3500);
  });
  it.each([0, -1, 1.5, 1000, 2499, NaN, Infinity, '2000', 3500, 999999999])('rejects invalid price %s', value => {
    expect(() => validateBookingPriceProposal(value, trip, 2)).toThrow();
  });
  it('rejects free/private/shared trips and monetary overflow', () => {
    expect(() => validateBookingPriceProposal(1, { ...trip, isFree: true } as Trip, 1)).toThrow();
    expect(() => validateBookingPriceProposal(1, { ...trip, tripRequestId: 'request' } as Trip, 1)).toThrow();
    expect(() => validateBookingPriceProposal(3000, trip, 999999)).toThrow();
    expect(() => validateBookingPriceProposal(3000, trip, 1.5)).toThrow();
  });
  it('validates HTTP DTOs as numbers, never coerces arbitrary amounts', async () => {
    for (const value of [0, -1, 1.5, '2000', Infinity, 100000000]) {
      expect((await validate(Object.assign(new CreateBookingDto(), { tripId: 'trip', numberOfSeats: 1, proposedPricePerSeat: value }))).length).toBeGreaterThan(0);
      expect((await validate(Object.assign(new AcceptBookingDto(), { acceptedPricePerSeat: value }))).length).toBeGreaterThan(0);
    }
    expect(await validate(Object.assign(new AcceptBookingDto(), { acceptedPricePerSeat: 2000 }))).toHaveLength(0);
  });

  const fixture = () => {
    const booking: any = { id: 'booking', tripId: 'trip', passengerId: 'passenger', numberOfSeats: 2,
      status: BookingStatus.PENDING, proposedPricePerSeat: 2500, grossPaymentAmount: 7000,
      paymentAmount: 2800, paymentStatus: BookingPaymentStatus.PENDING, firstTripSubsidyApplied: true,
      passengerPaymentRate: 0.4, zwangaSubsidyAmount: 4200 };
    const currentTrip: any = { ...trip, id: 'trip', driverId: 'driver', status: TripStatus.PENDING, totalSeats: 4, availableSeats: 4 };
    const insert = { insert: jest.fn().mockReturnThis(), into: jest.fn().mockReturnThis(), values: jest.fn().mockReturnThis(),
      onConflict: jest.fn().mockReturnThis(), execute: jest.fn() };
    const save = jest.fn(async v => v);
    const manager = { createQueryBuilder: () => insert, getRepository: entity => ({
      findOne: async () => entity === Booking ? booking : currentTrip, save,
    }) };
    const service: any = Object.assign(Object.create(BookingsService.prototype), {
      FIRST_TRIP_SUBSIDY_RELEASED_STATUSES: [BookingStatus.CANCELLED, BookingStatus.REJECTED, BookingStatus.EXPIRED,
        BookingStatus.NO_SHOW, BookingStatus.BOARDING_UNCERTAIN],
      bookingRepository: { manager: { transaction: async work => work(manager) } },
      ensurePassengerKycApprovedForTrip: jest.fn(), getAcceptedSeatCount: jest.fn(async () => 0),
      invalidateBookingCaches: jest.fn(), refundPointsPaymentIfNeeded: jest.fn(),
      recalculateAvailableSeatsForTrip: jest.fn(), logger: { log() {}, warn() {} },
      canReserveFirstTripSubsidy: jest.fn(async () => false),
    });
    return { service, booking, trip: currentTrip, save, insert };
  };
  it('explicit acceptance applies the agreed fare and existing welcome subsidy once', async () => {
    const f = fixture();
    await f.service.acceptBooking('booking', 'driver', 2500);
    expect(f.booking).toMatchObject({ status: 'accepted', grossPaymentAmount: 5000, paymentAmount: 2000, zwangaSubsidyAmount: 3000 });
    expect(f.trip.pricePerSeat).toBe(3500);
    expect(f.trip.availableSeats).toBe(2);
    await f.service.acceptBooking('booking', 'driver', 2500);
    expect(f.trip.availableSeats).toBe(2);
    expect(f.insert.execute).toHaveBeenCalledTimes(1);
  });
  it.each(['screen', 'status', 'native', 'wrong-price'])('rejects unacknowledged acceptance through %s', async source => {
    const f = fixture();
    const work = source === 'native' ? f.service.respondToInvitation('booking', 'driver', true)
      : source === 'status' ? f.service.updateStatus('booking', 'driver', { status: BookingStatus.ACCEPTED })
      : f.service.acceptBooking('booking', 'driver', source === 'wrong-price' ? 1000 : undefined);
    await expect(work).rejects.toThrow('Ce passager propose un autre prix');
    expect(f.booking.grossPaymentAmount).toBe(7000);
    expect(f.booking.status).toBe('pending');
    expect(f.save).not.toHaveBeenCalled();
    expect(f.insert.execute).not.toHaveBeenCalled();
  });
  it('a non-subsidized passenger pays the agreed total', async () => {
    const f = fixture(); f.booking.firstTripSubsidyApplied = false; f.booking.passengerPaymentRate = null;
    await f.service.acceptBooking('booking', 'driver', 2500);
    expect(f.booking.paymentAmount).toBe(5000);
    expect(f.booking.zwangaSubsidyAmount).toBe(0);
  });
  it('refusal remains possible without accepting or altering the price', async () => {
    const f = fixture();
    await f.service.respondToInvitation('booking', 'driver', false);
    expect(f.booking.status).toBe('rejected');
    expect(f.booking.grossPaymentAmount).toBe(7000);
    expect(f.trip.availableSeats).toBe(4);
  });
  it.each(['paidAt', 'cashReceivedAt', 'mixedPaymentAt', 'paymentTransactionId', 'fareAdjustedAt'])('does not reprice after %s', field => {
    const f = fixture(); f.booking[field] = 'existing';
    expect(() => acceptedBookingProposalTotal(f.booking, 2500)).toThrow('règlement');
  });
  it('rejects another driver and insufficient capacity before altering the fare', async () => {
    const f = fixture();
    await expect(f.service.acceptBooking('booking', 'other', 2500)).rejects.toThrow('Seul le conducteur');
    f.trip.totalSeats = 1;
    await expect(f.service.acceptBooking('booking', 'driver', 2500)).rejects.toThrow('Pas assez');
    expect(f.booking.grossPaymentAmount).toBe(7000);
    expect(f.save).not.toHaveBeenCalled();
  });
});
