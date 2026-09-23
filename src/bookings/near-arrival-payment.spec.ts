import { Booking, BookingPaymentStatus, BookingStatus } from './entities/booking.entity';
import { Trip } from '../trips/entities/trip.entity';
import { TripPaymentMode } from '../payments/enums/trip-payment-mode.enum';
import { BookingsService } from './bookings.service';
import { canPayNearArrival } from './near-arrival-payment';

const now = Date.parse('2026-09-16T10:00:00Z');
const destination = { type: 'Point' as const, coordinates: [15.3, -4.32] };
const position = (meters: number) => ({ type: 'Point' as const, coordinates: [15.3, -4.32 + meters / 6_371_000 * 180 / Math.PI] });
function fixture(distance = 500): Booking {
  return {
    id: 'booking', tripId: 'trip', passengerId: 'passenger',
    status: BookingStatus.ACCEPTED, pickedUp: true, droppedOff: false,
    paymentMode: TripPaymentMode.ELECTRONIC, paymentStatus: BookingPaymentStatus.PENDING,
    paymentAmount: 5000, grossPaymentAmount: 5000,
    passengerDestinationPoint: destination,
    passengerCurrentLocation: position(distance), passengerLastLocationUpdateAt: new Date(now),
    trip: { id: 'trip', status: 'ongoing', arrivalPoint: position(5000), currentLocation: null },
  } as unknown as Booking;
}

describe('Near-arrival payment permission', () => {
  beforeEach(() => { jest.useFakeTimers().setSystemTime(now); });
  afterEach(() => jest.useRealTimers());

  it.each([0, 20, 149, 150, 151, 300, 499, 500])('allows digital payment at %i metres without completing the booking', distance => {
    const booking = fixture(distance);
    expect(canPayNearArrival(booking)).toBe(true);
    expect(booking.status).toBe('accepted');
    expect(booking.droppedOff).toBe(false);
    booking.paymentMode = TripPaymentMode.POINTS;
    expect(canPayNearArrival(booking)).toBe(true);
  });
  it('rejects 1001 metres, missing boarding evidence, cash, cancelled trips and disputes', () => {
    expect(canPayNearArrival(fixture(1001))).toBe(false);
    for (const patch of [
      { pickedUp: false, pickedUpConfirmedByPassenger: true },
      { paymentMode: TripPaymentMode.CASH }, { status: BookingStatus.CANCELLED },
      { rideDeclarations: { pickup: { passenger: { decision: 'reject' } } } },
      { trip: { ...fixture().trip, status: 'cancelled' } },
    ]) expect(canPayNearArrival({ ...fixture(), ...patch } as Booking)).toBe(false);
  });
  it('uses the personal destination, falling back to the trip only when absent', () => {
    const booking = fixture(100);
    expect(canPayNearArrival(booking)).toBe(true);
    booking.passengerDestinationPoint = null;
    expect(canPayNearArrival(booking)).toBe(false);
    booking.trip.arrivalPoint = destination;
    expect(canPayNearArrival(booking)).toBe(true);
  });
  it('rejects stale/future/invalid GPS but accepts a fresh driver position', () => {
    const booking = fixture(100);
    booking.passengerLastLocationUpdateAt = new Date(now - 30_001);
    expect(canPayNearArrival(booking)).toBe(false);
    booking.passengerLastLocationUpdateAt = new Date(now + 10_000);
    expect(canPayNearArrival(booking)).toBe(false);
    booking.passengerCurrentLocation = position(NaN);
    booking.trip.currentLocation = position(500);
    booking.trip.lastLocationUpdateAt = new Date(now);
    expect(canPayNearArrival(booking)).toBe(true);
  });
  it('the existing electronic-payment gate keeps arrivals payable and accepts the new radius', () => {
    const service = Object.create(BookingsService.prototype) as any;
    expect(() => service.ensureBookingCanBePaid(fixture())).not.toThrow();
    expect(() => service.ensureBookingCanBePaid(fixture(1001))).toThrow('1000 mètres');
    expect(() => service.ensureBookingCanBePaid({ ...fixture(5000), status: 'completed' })).not.toThrow();
  });
});

describe('Early points settlement', () => {
  beforeEach(() => { jest.useFakeTimers().setSystemTime(now); });
  afterEach(() => jest.useRealTimers());
  function serviceFixture() {
    const booking = { ...fixture(500), paymentMode: TripPaymentMode.POINTS };
    const manager = {
      findOne: jest.fn(async (entity) => entity === Booking ? booking : booking.trip),
      save: jest.fn(async value => value),
    };
    const service = Object.assign(Object.create(BookingsService.prototype), {
      dataSource: { transaction: async callback => callback(manager) },
      getTripPaymentCurrency: () => 'CDF',
      applyFirstTripSubsidyPolicy: jest.fn(),
      saveBookingWithFirstTripSubsidyRaceFallback: async value => value,
      walletService: { payForBookingWithManager: jest.fn() },
      driverSettlementsService: { recordCompletedBookingEarningWithManager: jest.fn() },
      logger: { log: jest.fn() },
    }) as any;
    return { service, booking, manager };
  }
  it('debits the agreed amount without dropoff, rewards or early driver settlement', async () => {
    const { service, booking, manager } = serviceFixture();
    const result = await service.capturePointsPaymentForBooking(booking, booking.trip);
    expect(service.walletService.payForBookingWithManager).toHaveBeenCalledWith(manager, booking, 5000);
    expect(result.paymentStatus).toBe('succeeded');
    expect(result.status).toBe('accepted');
    expect(result.droppedOff).toBe(false);
    expect(service.driverSettlementsService.recordCompletedBookingEarningWithManager).not.toHaveBeenCalled();
    await service.capturePointsPaymentForBooking(booking, booking.trip);
    expect(service.walletService.payForBookingWithManager).toHaveBeenCalledTimes(1);
  });
  it('rechecks proximity under the booking lock before spending tokens', async () => {
    const { service, booking, manager } = serviceFixture();
    manager.findOne.mockImplementation(async entity => entity === Booking ? { ...booking, passengerCurrentLocation: position(1001) } : booking.trip as Trip);
    await expect(service.capturePointsPaymentForBooking(booking, booking.trip)).rejects.toThrow('1000 mètres');
    expect(service.walletService.payForBookingWithManager).not.toHaveBeenCalled();
  });
});
