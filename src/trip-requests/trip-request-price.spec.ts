import { TripRequestsService } from './trip-requests.service';
import { TripRequestStatus } from './entities/trip-request.entity';
import { DriverOfferStatus } from './entities/driver-offer.entity';
import { VehicleType } from '../vehicles/entities/vehicle.entity';

describe('Confirmed request price propagation', () => {
  function buildService(price: number | string) {
    const request = {
      id: 'request-1',
      passengerId: 'passenger-1',
      passenger: { id: 'passenger-1' },
      status: TripRequestStatus.PENDING,
      tripId: null as string | null,
      departureLocation: 'Gombe',
      arrivalLocation: 'Limete',
      departureDateMin: new Date(Date.now() + 30 * 60_000),
      departureDateMax: new Date(Date.now() + 90 * 60_000),
      departurePoint: { type: 'Point', coordinates: [15.31, -4.31] },
      arrivalPoint: { type: 'Point', coordinates: [15.4, -4.4] },
      maxPricePerSeat: price,
      selectedPricePerSeat: price,
      numberOfSeats: 2,
      paymentMode: 'cash',
      vehicleType: VehicleType.CAR,
      selectedDriverId: 'driver-1',
      selectedVehicleId: 'vehicle-1',
      driverOffers: [],
    };
    const acceptedOffer = {
      id: 'offer-1',
      status: DriverOfferStatus.ACCEPTED,
      proposedDepartureDate: request.departureDateMin,
      availableSeats: 4,
      pricePerSeat: price,
      requiresPassengerKyc: false,
    };
    const repository = {
      findOne: jest.fn().mockResolvedValue(request),
      save: jest.fn(async (value) => value),
    };
    const tripsService = {
      create: jest.fn(async (_driverId, payload) => ({
        id: 'trip-1',
        ...payload,
      })),
      ensureDriverCanStartTrip: jest.fn(),
      startTrip: jest.fn().mockResolvedValue({ id: 'trip-1' }),
    };
    const bookingsService = {
      create: jest.fn(),
      findAllByTrip: jest
        .fn()
        .mockResolvedValue([
          { id: 'booking-1', passengerId: request.passengerId },
        ]),
      acceptBooking: jest.fn(),
    };
    const service = new TripRequestsService(
      repository as any,
      {
        findOne: jest.fn().mockResolvedValue(acceptedOffer),
        update: jest.fn(),
      } as any,
      { findOne: jest.fn(async ({ where }) => ({ id: where.id })) } as any,
      {
        findOne: jest
          .fn()
          .mockResolvedValue({
            id: 'vehicle-1',
            ownerId: 'driver-1',
            type: VehicleType.CAR,
            isActive: true,
          }),
      } as any,
      {} as any,
      {} as any,
      tripsService as any,
      bookingsService as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    jest
      .spyOn(service, 'findOne')
      .mockImplementation(async () => ({ ...request }) as any);
    const calculatePrice = jest
      .spyOn(service as any, 'calculateRecommendedPricePerSeat')
      .mockRejectedValue(
        new Error('A confirmed price must never be recalculated'),
      );
    return {
      service,
      request,
      repository,
      tripsService,
      bookingsService,
      calculatePrice,
    };
  }

  it.each([2000, '1945.00', 0, '0.00'])(
    'direct acceptance copies %s per seat even when the driver has more seats or changes the pickup point',
    async (price) => {
      const {
        service,
        request,
        tripsService,
        bookingsService,
        calculatePrice,
      } = buildService(price);
      const result = await service.acceptTripRequest('driver-1', request.id, {
        vehicleId: 'vehicle-1',
        totalSeats: 4,
        departureCoordinates: [15.32, -4.32],
      });
      expect(tripsService.create).toHaveBeenCalledWith(
        'driver-1',
        expect.objectContaining({
          pricePerSeat: Number(price),
          isFree: Number(price) === 0,
          totalSeats: 4,
        }),
        { isPrivate: true, tripRequestId: request.id },
      );
      expect(bookingsService.create).toHaveBeenCalledWith(
        'passenger-1',
        expect.objectContaining({
          tripId: 'trip-1',
          numberOfSeats: 2,
          paymentMode: 'cash',
        }),
      );
      expect(bookingsService.acceptBooking).toHaveBeenCalledWith(
        'booking-1',
        'driver-1',
      );
      expect(result.tripRequest.selectedPricePerSeat).toBe(Number(price));
      expect(calculatePrice).not.toHaveBeenCalled();
    },
  );

  it.each([2000, '1945.00', 0, '0.00'])(
    'starting a previously accepted offer uses the selected price %s, not the initial maximum',
    async (price) => {
      const { service, request, tripsService, calculatePrice } =
        buildService(price);
      request.status = TripRequestStatus.DRIVER_SELECTED;
      request.maxPricePerSeat = 9000;
      await service.startTripFromRequest(request.id, 'driver-1');
      expect(tripsService.create).toHaveBeenCalledWith(
        'driver-1',
        expect.objectContaining({
          pricePerSeat: Number(price),
          isFree: Number(price) === 0,
        }),
        { isPrivate: true, tripRequestId: request.id },
      );
      expect(tripsService.startTrip).toHaveBeenCalledWith('trip-1', 'driver-1');
      expect(calculatePrice).not.toHaveBeenCalled();
    },
  );

  it.each([2000, '1945.00', 0, '0.00', null])(
    'serializes saved prices without losing zero: %s',
    async (price) => {
      const { service, request } = buildService(2000);
      jest
        .spyOn(service as any, 'sanitizeUser')
        .mockImplementation(async (user) => user ?? null);
      jest.spyOn(service as any, 'sanitizeVehicle').mockResolvedValue(null);
      const result = await (service as any).sanitizeTripRequest({
        ...request,
        maxPricePerSeat: price,
        selectedPricePerSeat: price,
      });
      expect(result.maxPricePerSeat).toBe(
        price === null ? null : Number(price),
      );
      expect(result.selectedPricePerSeat).toBe(
        price === null ? null : Number(price),
      );
    },
  );
});
