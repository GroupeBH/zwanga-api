import { BookingsService } from './bookings.service';
import { BookingPaymentStatus, BookingStatus } from './entities/booking.entity';
import { TripPaymentMode } from '../payments/enums/trip-payment-mode.enum';
import { TripStatus } from '../trips/entities/trip.entity';

const origin = { type: 'Point', coordinates: [15.3, -4.3] };
const destination = { type: 'Point', coordinates: [15.4, -4.4] };
const location = { type: 'Point', coordinates: [15.32, -4.32] };

function fixture(original = 10000, passenger = original, travelled = 5000) {
  const service: any = Object.create(BookingsService.prototype);
  const booking: any = { id: 'booking', passengerId: 'passenger', tripId: 'trip',
    numberOfSeats: 2, status: BookingStatus.ACCEPTED, pickedUp: true, pickedUpConfirmedByPassenger: true,
    grossPaymentAmount: original, paymentAmount: passenger, paymentCurrency: 'CDF',
    paymentMode: TripPaymentMode.CASH, paymentStatus: BookingPaymentStatus.NOT_REQUIRED,
    passengerOriginPoint: origin, passengerDestinationPoint: destination,
    trip: { status: TripStatus.ACTIVE, departurePoint: origin, arrivalPoint: destination,
      currentLocation: location, pricePerSeat: 99999 } };
  service.bookingRepository = { findOne: jest.fn(async () => booking), save: jest.fn(async value => value) };
  service.calculateRouteDistanceMeters = jest.fn(async (_from, to) => to === destination ? 25000 : travelled);
  service.saveBookingWithFirstTripSubsidyRaceFallback = jest.fn(async value => value);
  service.walletService = { creditBookingFareAdjustment: jest.fn() };
  service.settlePaymentAfterArrival = jest.fn(async value => value);
  service.touchTripInteraction = jest.fn();
  service.invalidateBookingCaches = jest.fn();
  return { service, booking };
}

describe('passenger emergency dropoff pricing', () => {
  it.each([
    [10000, 10000, 5000, 2000],
    [5000, 5000, 5000, 1500],
    [1000, 1000, 5000, 1000],
    [10000, 4000, 5000, 1500],
    [10000, 10000, 30000, 10000],
    [10000, 10000, 0, 1500],
  ])('preview and settlement agree for gross %s / passenger %s / distance %s', async (gross, passenger, travelled, expected) => {
    const { service, booking } = fixture(gross, passenger, travelled);
    const preview = await service.previewPassengerInterruptionFare('booking', 'passenger');
    expect(preview).toMatchObject({ bookingId: 'booking', isEstimate: true, passengerAmount: expected,
      minimumAmount: Math.min(1500, passenger), originalPassengerAmount: passenger });
    expect(service.bookingRepository.save).not.toHaveBeenCalled();
    expect(service.walletService.creditBookingFareAdjustment).not.toHaveBeenCalled();
    const result = await service.completeBookingByTripInterruption('booking', location);
    expect(result.paymentAmount).toBe(preview.passengerAmount);
    expect(result.grossPaymentAmount).toBe(preview.finalAmount);
    expect(result.interruptionFareLocked).toBe(true);
    expect(result.status).toBe(BookingStatus.COMPLETED);
    expect(result.paymentMode).toBe(TripPaymentMode.CASH);
    expect(result.paymentStatus).toBe(BookingPaymentStatus.NOT_REQUIRED);
    expect(result.paymentAmount).toBeLessThanOrEqual(passenger);
    await service.applyFirstTripSubsidyPolicy(booking, booking.trip);
    expect(booking.paymentAmount).toBe(expected);
  });

  it('keeps the stored price for legacy bookings without a gross amount despite trip price edits', async () => {
    const { service, booking } = fixture();
    delete booking.grossPaymentAmount;
    const preview = await service.previewPassengerInterruptionFare('booking', 'passenger');
    expect(preview.originalPassengerAmount).toBe(10000);
    expect(preview.passengerAmount).toBe(2000);
    const result = await service.completeBookingByTripInterruption('booking', location);
    expect(result.paymentAmount).toBe(2000);
  });

  it.each([TripPaymentMode.ELECTRONIC, TripPaymentMode.POINTS])('credits only the prepaid difference for %s, once', async mode => {
    const { service, booking } = fixture();
    booking.paymentMode = mode;
    booking.paymentStatus = BookingPaymentStatus.SUCCEEDED;
    const preview = await service.previewPassengerInterruptionFare('booking', 'passenger');
    expect(preview.prepaidAmount).toBe(10000);
    await service.completeBookingByTripInterruption('booking', location);
    await service.completeBookingByTripInterruption('booking', location);
    expect(service.walletService.creditBookingFareAdjustment).toHaveBeenCalledTimes(1);
    expect(service.walletService.creditBookingFareAdjustment).toHaveBeenCalledWith(booking, 8000);
    expect(booking.paymentAmount).toBe(2000);
  });

  it('a free booking remains free even if the trip price changed', async () => {
    const { service } = fixture(0, 0);
    const result = await service.completeBookingByTripInterruption('booking', location);
    expect(result.paymentAmount).toBe(0);
    expect(service.calculateRouteDistanceMeters).not.toHaveBeenCalled();
  });

  it('preview checks ownership before any distance or financial operation', async () => {
    const { service } = fixture();
    service.bookingRepository.findOne.mockResolvedValueOnce(null);
    await expect(service.previewPassengerInterruptionFare('booking', 'stranger')).rejects.toThrow('Réservation non trouvée');
    expect(service.bookingRepository.findOne).toHaveBeenCalledWith({ where: { id: 'booking', passengerId: 'stranger' }, relations: ['trip'] });
    expect(service.calculateRouteDistanceMeters).not.toHaveBeenCalled();
  });

  it.each(['not_boarded', 'completed', 'trip_finished'])('rejects preview outside a live onboard reservation: %s', async state => {
    const { service, booking } = fixture();
    if (state === 'not_boarded') { booking.pickedUp = false; booking.pickedUpConfirmedByPassenger = false; }
    if (state === 'completed') booking.status = BookingStatus.COMPLETED;
    if (state === 'trip_finished') booking.trip.status = TripStatus.COMPLETED;
    await expect(service.previewPassengerInterruptionFare('booking', 'passenger')).rejects.toThrow();
    expect(service.calculateRouteDistanceMeters).not.toHaveBeenCalled();
  });

  it('an unavailable estimate makes no state changes and never substitutes zero', async () => {
    const { service } = fixture();
    service.calculateRouteDistanceMeters.mockResolvedValue(null);
    await expect(service.previewPassengerInterruptionFare('booking', 'passenger')).rejects.toThrow('indisponible');
    expect(service.bookingRepository.save).not.toHaveBeenCalled();
    expect(service.walletService.creditBookingFareAdjustment).not.toHaveBeenCalled();
  });

  it('validates coordinates before routing', async () => {
    const { service } = fixture();
    await expect(service.previewPassengerInterruptionFare('booking', 'passenger', { latitude: NaN, longitude: 300 })).rejects.toThrow();
    expect(service.calculateRouteDistanceMeters).not.toHaveBeenCalled();
  });

  it('does not reprice an in-flight electronic payment', async () => {
    const { service, booking } = fixture();
    booking.paymentMode = TripPaymentMode.ELECTRONIC;
    booking.paymentStatus = BookingPaymentStatus.INITIATED;
    booking.paymentTransactionId = 'payment';
    await expect(service.completeBookingByTripInterruption('booking', location)).rejects.toThrow('Un paiement est déjà en cours');
    expect(booking.paymentAmount).toBe(10000);
    expect(service.bookingRepository.save).not.toHaveBeenCalled();
  });
});
