import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { Trip, TripStatus } from '../trips/entities/trip.entity';
import { Vehicle, VehicleType } from '../vehicles/entities/vehicle.entity';
import { TripRequest, TripRequestStatus } from './entities/trip-request.entity';
import { TripPaymentMode } from '../payments/enums/trip-payment-mode.enum';
import { assertSharedTripAvailable } from './shared-trip-policy';
import {
  AcceptSharedTripDto,
  ProposeSharedTripDto,
} from './shared-trip-offers.controller';

const now = Date.now();
const request = {
  passengerId: 'passenger',
  status: TripRequestStatus.PENDING,
  numberOfSeats: 1,
  maxPricePerSeat: 1000,
  vehicleType: VehicleType.CAR,
  departureDateMin: new Date(now),
  departureDateMax: new Date(now + 600_000),
  paymentMode: TripPaymentMode.CASH,
} as TripRequest;
const trip = {
  driverId: 'driver',
  vehicleId: 'vehicle',
  status: TripStatus.ACTIVE,
  totalSeats: 4,
  availableSeats: 1,
  pricePerSeat: 800,
  acceptedPaymentModes: [TripPaymentMode.CASH],
} as Trip;
const vehicle = {
  id: 'vehicle',
  ownerId: 'driver',
  isActive: true,
  type: VehicleType.CAR,
} as Vehicle;

describe('shared ride consent and availability policy', () => {
  it('allows a compatible ongoing trip with seats and an unchanged payment mode', () => {
    expect(() =>
      assertSharedTripAvailable(request, trip, vehicle, 'driver', now),
    ).not.toThrow();
  });
  it.each([
    { status: TripStatus.COMPLETED },
    { status: TripStatus.PENDING },
    { availableSeats: 0 },
    { totalSeats: null },
    { totalSeats: 21 },
    { driverId: 'other' },
    { destinationReachedAt: new Date() },
    { pricePerSeat: 1001 },
    { pricePerSeat: NaN },
    { acceptedPaymentModes: [TripPaymentMode.POINTS] },
  ])('rejects a changed trip %j', (patch) => {
    expect(() =>
      assertSharedTripAvailable(
        request,
        { ...trip, ...patch } as Trip,
        vehicle,
        'driver',
        now,
      ),
    ).toThrow();
  });
  it.each([
    { passengerId: 'driver' },
    { selectedDriverId: 'other' },
    { tripId: 'other' },
    { status: TripRequestStatus.CANCELLED },
    { numberOfSeats: 2 },
    { departureDateMax: new Date(now) },
    { departureDateMin: new Date(now + 600_001) },
  ])('rejects an incompatible request %j', (patch) => {
    expect(() =>
      assertSharedTripAvailable(
        { ...request, ...patch } as TripRequest,
        trip,
        vehicle,
        'driver',
        now,
      ),
    ).toThrow();
  });
  it.each([
    null,
    { ...vehicle, isActive: false },
    { ...vehicle, ownerId: 'other' },
    { ...vehicle, type: VehicleType.MOTORCYCLE_TWO_WHEELS },
  ])('revalidates the vehicle %j', (changed) => {
    expect(() =>
      assertSharedTripAvailable(request, trip, changed, 'driver', now),
    ).toThrow();
  });
  it.each([undefined, null, false, 'true', 'false', 1, {}, []])(
    'does not coerce consent %s',
    async (consent) => {
      expect(
        (await validate(plainToInstance(AcceptSharedTripDto, { consent }, { enableImplicitConversion: true })))
          .length,
      ).toBeGreaterThan(0);
    },
  );
  it('accepts only a literal true and a UUID trip identifier', async () => {
    expect(
      await validate(plainToInstance(AcceptSharedTripDto, { consent: true }, { enableImplicitConversion: true })),
    ).toHaveLength(0);
    expect(
      (
        await validate(
          plainToInstance(ProposeSharedTripDto, { tripId: 'not-a-uuid' }),
        )
      ).length,
    ).toBeGreaterThan(0);
  });
});
