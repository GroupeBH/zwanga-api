import { BookingResponseInterceptor } from './booking-response.interceptor';
import { bookingResponse, BookingResponseAccess } from './booking-response';
import { BookingStatus } from './entities/booking.entity';
import { TripStatus } from '../trips/entities/trip.entity';
import { BookingsController } from './bookings.controller';
import { CashReceiptsController } from './cash-receipts.controller';
import { MixedCashPaymentController } from './mixed-cash-payment.controller';
import { TokenCashFallbackController } from './token-cash-fallback.controller';
import { PaymentRequestController } from './payment-request.controller';
import { INTERCEPTORS_METADATA } from '@nestjs/common/constants';

const gps = { type: 'Point', coordinates: [15.3, -4.3] };
const person = (id: string) => ({
  id,
  firstName: 'Test',
  phone: 'private-phone',
  email: 'private-email',
  fcmToken: 'private-push',
  password: 'private-hash',
  currentLocation: gps,
  documents: [{ url: 'private-document' }],
});
const access = (
  patch: Partial<BookingResponseAccess> = {},
): BookingResponseAccess => ({
  id: 'booking',
  tripId: 'trip',
  passengerId: 'passenger',
  driverId: 'driver',
  status: BookingStatus.ACCEPTED,
  tripStatus: TripStatus.PENDING,
  departureDate: new Date(),
  droppedOff: false,
  droppedOffAt: null,
  droppedOffConfirmedByPassenger: false,
  currentLocation: gps,
  lastLocationUpdateAt: new Date(),
  passengerCurrentLocation: gps,
  passengerLastLocationUpdateAt: new Date(),
  ...patch,
});
const entity = () => ({
  id: 'booking',
  tripId: 'trip',
  passengerId: 'passenger',
  status: 'accepted',
  paymentStatus: 'pending',
  paymentAmount: 1000,
  passenger: person('passenger'),
  passengerCurrentLocation: gps,
  rideDeclarations: { secret: true },
  trip: {
    id: 'trip',
    driverId: 'driver',
    driver: person('driver'),
    currentLocation: gps,
    bookings: [{ passenger: person('other') }],
    vehicle: { id: 'vehicle', licensePlate: 'ABC', owner: person('driver') },
  },
  tripInterruptionRequest: {
    id: 'interruption',
    confirmations: [
      { passengerId: 'passenger', passenger: person('passenger') },
      { passengerId: 'other', passenger: person('other') },
    ],
  },
});

describe('booking HTTP confidentiality', () => {
  it.each([
    BookingStatus.PENDING,
    BookingStatus.REJECTED,
    BookingStatus.CANCELLED,
    BookingStatus.COMPLETED,
    BookingStatus.EXPIRED,
  ])(
    'hides contact and live GPS for %s, even in an old accepted cache entry',
    (status) => {
      const response = bookingResponse(
        entity(),
        access({ status }),
        'passenger',
      );
      const serialized = JSON.stringify(response);
      for (const value of [
        'private-phone',
        'private-email',
        'private-push',
        'private-hash',
        'private-document',
        'rideDeclarations',
      ])
        expect(serialized).not.toContain(value);
      expect(response.trip?.currentLocation).toBeNull();
      expect(response.passengerCurrentLocation).toBeNull();
      expect(response.status).toBe(status);
      expect(response.trip?.bookings).toEqual([]);
    },
  );
  it('keeps useful contact and fresh driver GPS before departure after acceptance', () => {
    const response = bookingResponse(entity(), access(), 'passenger');
    expect(response.trip?.currentLocation).toEqual(gps);
    expect(response.trip?.driver).toMatchObject({
      id: 'driver',
      phone: 'private-phone',
    });
    expect(JSON.stringify(response)).not.toMatch(
      /private-(push|email|hash|document)/,
    );
    expect(response.tripInterruptionRequest?.confirmations).toHaveLength(1);
  });
  it.each([
    { droppedOff: true },
    { tripStatus: TripStatus.COMPLETED },
    { lastLocationUpdateAt: new Date(Date.now() - 125_000) },
  ])('does not expose stale or terminal tracking: %j', (patch) => {
    expect(
      bookingResponse(entity(), access(patch), 'passenger').trip
        ?.currentLocation,
    ).toBeNull();
  });
  it('does not expose the former driver from cache after reassignment', () => {
    expect(
      bookingResponse(
        entity(),
        access({ driverId: 'replacement' }),
        'passenger',
      ).trip?.driver,
    ).toBeNull();
    expect(() =>
      bookingResponse(entity(), access({ driverId: 'replacement' }), 'driver'),
    ).toThrow();
  });
  it('denies a non-participant and a deleted booking', () => {
    expect(() => bookingResponse(entity(), access(), 'outsider')).toThrow();
    expect(() => bookingResponse(entity(), undefined, 'passenger')).toThrow();
  });
  it('sanitizes nested paginated/mutation payloads with one fresh query', async () => {
    const qb: any = {
      getRawMany: jest
        .fn()
        .mockResolvedValue([access({ status: BookingStatus.CANCELLED })]),
    };
    for (const method of ['innerJoin', 'select', 'addSelect', 'where'])
      qb[method] = jest.fn().mockReturnValue(qb);
    const repository: any = {
      createQueryBuilder: jest.fn().mockReturnValue(qb),
    };
    const response: any = await new BookingResponseInterceptor(
      repository,
    ).present(
      { data: [entity()], total: 40, payment: { booking: entity() } },
      'passenger',
    );
    expect(qb.getRawMany).toHaveBeenCalledTimes(1);
    expect(response.total).toBe(40);
    expect(response.data[0].status).toBe('cancelled');
    expect(JSON.stringify(response)).not.toContain('private-push');
    expect(response.payment.booking.trip.currentLocation).toBeNull();
  });
  it('is actually wired to read and cash receipt controllers', () => {
    for (const controller of [
      BookingsController,
      CashReceiptsController,
      MixedCashPaymentController,
      TokenCashFallbackController,
      PaymentRequestController,
    ])
      expect(Reflect.getMetadata(INTERCEPTORS_METADATA, controller)).toContain(
        BookingResponseInterceptor,
      );
  });
});
