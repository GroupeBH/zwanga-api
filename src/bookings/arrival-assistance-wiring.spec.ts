import { BookingsService } from './bookings.service';

// Exercise the real progression method; only dependencies and earlier GPS
// predicates are simulated. No database, .env, push or payment provider.
describe('arrival assistance integration with automatic progression', () => {
  function fixture() {
    const history = { current: null, previous: null, samples: [] };
    const point = { type: 'Point', coordinates: [15.3, -4.3] };
    const booking: any = {
      id: 'booking',
      tripId: 'trip',
      pickedUp: true,
      trip: { currentLocation: point, lastLocationUpdateAt: new Date() },
    };
    const service = Object.assign(Object.create(BookingsService.prototype), {
      canEvaluateAutomaticProgress: jest.fn().mockReturnValue(true),
      hasBookingBeenPickedUpForRideProgress: jest.fn().mockReturnValue(true),
      getDropoffPoint: jest.fn().mockReturnValue(point),
      isFreshLocationUpdate: jest.fn().mockReturnValue(true),
      calculatePointDistanceMeters: jest.fn().mockReturnValue(70),
      hasFreshGpsPair: jest.fn().mockReturnValue(true),
      hasDriverContinuedAfterDropoffFromHistory: jest
        .fn()
        .mockReturnValue(true),
      areDriverAndPassengerMovingTogetherFromHistory: jest
        .fn()
        .mockReturnValue(false),
      locationHistoryService: {
        getDriverLocationHistory: jest.fn().mockResolvedValue(history),
        getPassengerLocationHistory: jest.fn().mockResolvedValue(history),
      },
      arrivalAssistance: { observe: jest.fn().mockResolvedValue(undefined) },
      completeAutomaticDropoff: jest
        .fn()
        .mockResolvedValue({ type: 'dropoff_confirmed' }),
      logger: { warn: jest.fn() },
      AUTO_DROPOFF_DIRECT_CONFIRM_THRESHOLD_METERS: 25,
      AUTO_DROPOFF_PASSENGER_STAY_THRESHOLD_METERS: 100,
      AUTO_DROPOFF_DRIVER_PASSENGER_SEPARATION_THRESHOLD_METERS: 50,
    });
    return { service, booking, history, point };
  }
  it('observes a possible stop even without passenger GPS, reusing driver history', async () => {
    const h = fixture();
    expect(await h.service.tryConfirmAutomaticDropoff(h.booking)).toBeNull();
    expect(h.service.arrivalAssistance.observe).toHaveBeenCalledWith(
      h.booking,
      h.history,
    );
    expect(
      h.service.locationHistoryService.getDriverLocationHistory,
    ).toHaveBeenCalledTimes(1);
    expect(h.service.completeAutomaticDropoff).not.toHaveBeenCalled();
  });
  it('does not delay direct GPS completion with proposal processing', async () => {
    const h = fixture();
    h.service.calculatePointDistanceMeters.mockReturnValue(10);
    expect(await h.service.tryConfirmAutomaticDropoff(h.booking)).toEqual({
      type: 'dropoff_confirmed',
    });
    expect(h.service.arrivalAssistance.observe).not.toHaveBeenCalled();
  });
  it('preserves separation completion and reads driver history only once', async () => {
    const h = fixture();
    h.booking.passengerDestinationApproachNotifiedAt = new Date();
    h.booking.passengerCurrentLocation = h.point;
    expect(await h.service.tryConfirmAutomaticDropoff(h.booking)).toEqual({
      type: 'dropoff_confirmed',
    });
    expect(h.service.completeAutomaticDropoff).toHaveBeenCalledWith(
      h.booking,
      expect.any(Date),
      'automatic_passenger_separation',
    );
    expect(
      h.service.locationHistoryService.getDriverLocationHistory,
    ).toHaveBeenCalledTimes(1);
    expect(h.service.arrivalAssistance.observe).not.toHaveBeenCalled();
  });
  it('falls back to assistance when separation does not prove arrival', async () => {
    const h = fixture();
    h.booking.passengerDestinationApproachNotifiedAt = new Date();
    h.booking.passengerCurrentLocation = h.point;
    h.service.areDriverAndPassengerMovingTogetherFromHistory.mockReturnValue(
      true,
    );
    expect(await h.service.tryConfirmAutomaticDropoff(h.booking)).toBeNull();
    expect(h.service.arrivalAssistance.observe).toHaveBeenCalledTimes(1);
    expect(h.service.completeAutomaticDropoff).not.toHaveBeenCalled();
  });
  it('a proposal outage does not fail ordinary ride progression', async () => {
    const h = fixture();
    h.service.arrivalAssistance.observe.mockRejectedValue(
      new Error('Redis unavailable'),
    );
    expect(await h.service.tryConfirmAutomaticDropoff(h.booking)).toBeNull();
    expect(h.service.logger.warn).toHaveBeenCalledTimes(1);
  });
  it('does not interpret a stale fix as a stopped vehicle', async () => {
    const h = fixture();
    h.service.isFreshLocationUpdate.mockReturnValue(false);
    expect(await h.service.tryConfirmAutomaticDropoff(h.booking)).toBeNull();
    expect(h.service.arrivalAssistance.observe).not.toHaveBeenCalled();
    expect(h.service.completeAutomaticDropoff).not.toHaveBeenCalled();
  });
});
