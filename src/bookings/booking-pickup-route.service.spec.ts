import { BookingsService } from './bookings.service';
import { Trip, TripStatus } from '../trips/entities/trip.entity';
import { User } from '../users/entities/user.entity';
import { TripPaymentMode } from '../payments/enums/trip-payment-mode.enum';
import type { Point } from 'typeorm';
import type { Booking } from './entities/booking.entity';

const point = (lat: number, lng: number): Point => ({
  type: 'Point',
  coordinates: [lng, lat],
});
const encode = (points: number[][]) => {
  let previous = [0, 0],
    encoded = '';
  for (const point of points) {
    const current = point.map((v) => Math.round(v * 1e5));
    current.forEach((value, index) => {
      const delta = value - previous[index];
      let remaining = delta < 0 ? -delta * 2 - 1 : delta * 2;
      while (remaining >= 32) {
        encoded += String.fromCharCode((remaining % 32) + 95);
        remaining = Math.floor(remaining / 32);
      }
      encoded += String.fromCharCode(remaining + 63);
    });
    previous = current;
  }
  return encoded;
};
function fixture() {
  const trip = {
    id: 'trip',
    driverId: 'driver',
    driver: {},
    status: TripStatus.PENDING,
    totalSeats: 3,
    availableSeats: 3,
    bookings: [],
    pricePerSeat: 3000,
    departureLocation: 'Départ de test',
    arrivalLocation: 'Arrivée de test',
    departurePoint: point(0, 15),
    arrivalPoint: point(0, 15.1),
    tripRequestId: null,
  } as unknown as Trip;
  const manager = {
    query: jest.fn(),
    findOne: jest.fn((entity: unknown) =>
      Promise.resolve(
        entity === Trip
          ? trip
          : entity === User
            ? { isActive: true, status: 'active' }
            : null,
      ),
    ),
  };
  const repository = {
    findOne: jest.fn(() => Promise.resolve(trip)),
    manager: {
      transaction: jest.fn(
        (work: (value: typeof manager) => Promise<unknown>) => work(manager),
      ),
    },
  };
  const mocks = {
    logger: { log() {}, warn() {} },
    tripRepository: repository,
    bookingRepository: {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((v: Partial<Booking>) => v),
    },
    ensurePassengerKycForExtraSeats: jest.fn(),
    ensurePassengerKycApprovedForTrip: jest.fn(),
    calculateAvailableSeatsFromAcceptedBookings: jest.fn(() => 3),
    calculateBookingPaymentAmount: jest.fn(() => 3000),
    getTripPaymentCurrency: jest.fn(() => 'CDF'),
    applyFirstTripSubsidyPolicy: jest.fn(),
    saveBookingWithFirstTripSubsidyRaceFallback: jest.fn((b: Booking) =>
      Promise.resolve({
        ...b,
        id: 'booking',
      }),
    ),
    cacheService: { del: jest.fn() },
    geocodeAddressToPoint: jest.fn().mockResolvedValue(point(0.01, 15.05)),
    googleMapsService: {
      getDirections: jest.fn().mockResolvedValue({
        status: 'OK',
        routes: [
          {
            legs: [
              {
                steps: [
                  {
                    polyline: encode([
                      [0, 15],
                      [0, 15.1],
                    ]),
                  },
                ],
              },
            ],
          },
        ],
      }),
    },
  };
  const instance = Object.create(BookingsService.prototype) as BookingsService;
  Object.assign(instance, mocks);
  const create: BookingsService['create'] = (
    passengerId,
    dto,
    sharedSelection,
  ) => instance.create(passengerId, dto, sharedSelection);
  const service = { ...mocks, create };
  return {
    trip,
    manager,
    repository,
    service,
    dto: {
      tripId: 'trip',
      numberOfSeats: 1,
      paymentMode: TripPaymentMode.CASH,
      passengerOriginCoordinates: { latitude: 0.01, longitude: 15.05 },
    },
  };
}

describe('BookingsService pickup rule before side effects', () => {
  it.each([TripStatus.PENDING, TripStatus.ACTIVE])(
    'rejects a distant pickup on a %s trip without saving or notifying',
    async (status) => {
      const f = fixture();
      f.trip.status = status;
      await expect(f.service.create('passenger', f.dto)).rejects.toMatchObject({
        response: { code: 'BOOKING_PICKUP_OFF_ROUTE' },
      });
      expect(f.service.bookingRepository.create).not.toHaveBeenCalled();
      expect(f.service.applyFirstTripSubsidyPolicy).not.toHaveBeenCalled();
      expect(f.repository.manager.transaction).not.toHaveBeenCalled();
      expect(f.service.cacheService.del).not.toHaveBeenCalled();
      expect(f.trip.availableSeats).toBe(3);
    },
  );
  it('also rejects a manually typed origin resolved by the server', async () => {
    const f = fixture();
    await expect(
      f.service.create('passenger', {
        ...f.dto,
        passengerOriginCoordinates: undefined,
        passengerOrigin: 'Point manuel de test',
      }),
    ).rejects.toMatchObject({ response: { code: 'BOOKING_PICKUP_OFF_ROUTE' } });
    expect(f.service.geocodeAddressToPoint).toHaveBeenCalled();
    expect(f.service.bookingRepository.create).not.toHaveBeenCalled();
  });
  it('checks a shared offer before selection, seats and price agreement are written', async () => {
    const f = fixture(),
      shared = {
        lockRequest: jest.fn(),
        validate: jest.fn(),
        selected: jest.fn(),
      };
    await expect(
      f.service.create('passenger', f.dto, shared),
    ).rejects.toMatchObject({
      response: { code: 'BOOKING_PICKUP_OFF_ROUTE' },
    });
    expect(shared.lockRequest).not.toHaveBeenCalled();
    expect(shared.selected).not.toHaveBeenCalled();
  });
  it('keeps the normal booking and payment payload for a pickup within the corridor', async () => {
    const f = fixture();
    f.dto.passengerOriginCoordinates.latitude = 0.0005;
    const result = await f.service.create('passenger', f.dto);
    expect(result).toMatchObject({
      id: 'booking',
      passengerId: 'passenger',
      numberOfSeats: 1,
      passengerOriginPoint: point(0.0005, 15.05),
      paymentMode: 'cash',
      grossPaymentAmount: 3000,
    });
    expect(
      f.service.saveBookingWithFirstTripSubsidyRaceFallback,
    ).toHaveBeenCalledTimes(1);
    expect(
      f.service.googleMapsService.getDirections.mock.invocationCallOrder[0],
    ).toBeLessThan(
      f.repository.manager.transaction.mock.invocationCallOrder[0],
    );
  });
  it('rejects an itinerary edited during validation before saving the booking', async () => {
    const f = fixture();
    f.dto.passengerOriginCoordinates.latitude = 0.0005;
    f.repository.findOne.mockResolvedValue({ ...f.trip });
    f.trip.arrivalPoint = point(0.02, 15.1);
    await expect(f.service.create('passenger', f.dto)).rejects.toThrow(
      'L’itinéraire a changé',
    );
    expect(
      f.service.saveBookingWithFirstTripSubsidyRaceFallback,
    ).not.toHaveBeenCalled();
  });
  it('does not silently accept a custom point when the directions provider is unavailable', async () => {
    const f = fixture();
    f.service.googleMapsService.getDirections.mockRejectedValue(
      Error('offline'),
    );
    await expect(f.service.create('passenger', f.dto)).rejects.toMatchObject({
      status: 503,
    });
    expect(f.service.bookingRepository.create).not.toHaveBeenCalled();
    expect(f.repository.manager.transaction).not.toHaveBeenCalled();
  });
});
