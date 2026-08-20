import { BadRequestException } from '@nestjs/common';
import { VehicleType } from '../vehicles/entities/vehicle.entity';
import { DriverOfferStatus } from './entities/driver-offer.entity';
import { TripRequestStatus } from './entities/trip-request.entity';
import { TripRequestsService } from './trip-requests.service';

describe('TripRequestsService recommended price', () => {
  it('recommends 500 FC per kilometer for cars and applies the heavy-rain coefficient', async () => {
    const weatherAwarenessService = {
      getRouteImpact: jest.fn().mockResolvedValue({
        heavyRain: true,
        dataAvailable: true,
        priceMultiplier: 1.3,
        etaMultiplier: 1.4,
        evaluatedZoneIds: ['cd-kinshasa-gombe'],
        affectedZoneIds: ['cd-kinshasa-gombe'],
      }),
    };
    const service = new TripRequestsService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      weatherAwarenessService as any,
    );
    jest
      .spyOn(service as any, 'resolvePointFromCoordinatesOrAddress')
      .mockResolvedValueOnce({
        type: 'Point',
        coordinates: [15.3136, -4.3073],
      })
      .mockResolvedValueOnce({
        type: 'Point',
        coordinates: [15.403, -4.4075],
      });
    jest
      .spyOn(service as any, 'calculateRouteDistanceMeters')
      .mockResolvedValue(5000);

    const recommendation = await service.recommendPrice({
      departureLocation: 'Gombe',
      arrivalLocation: "N'djili",
      numberOfSeats: 2,
      vehicleType: VehicleType.CAR,
    });

    expect(recommendation.vehicleType).toBe(VehicleType.CAR);
    expect(recommendation.pricePerKmPerPassenger).toBe(500);
    expect(recommendation.recommendedPricePerSeat).toBe(3250);
    expect(recommendation.recommendedTotalPrice).toBe(6500);
    expect(recommendation.weatherImpact.priceMultiplier).toBe(1.3);
  });

  it('recommends 1000 FC per kilometer for motorcycles', async () => {
    const weatherAwarenessService = {
      getRouteImpact: jest.fn().mockResolvedValue({
        heavyRain: false,
        dataAvailable: true,
        priceMultiplier: 1,
        etaMultiplier: 1,
        evaluatedZoneIds: [],
        affectedZoneIds: [],
      }),
    };
    const service = new TripRequestsService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      weatherAwarenessService as any,
    );
    jest
      .spyOn(service as any, 'resolvePointFromCoordinatesOrAddress')
      .mockResolvedValueOnce({
        type: 'Point',
        coordinates: [15.3136, -4.3073],
      })
      .mockResolvedValueOnce({
        type: 'Point',
        coordinates: [15.403, -4.4075],
      });
    jest
      .spyOn(service as any, 'calculateRouteDistanceMeters')
      .mockResolvedValue(5000);

    const recommendation = await service.recommendPrice({
      departureLocation: 'Gombe',
      arrivalLocation: "N'djili",
      numberOfSeats: 1,
      vehicleType: VehicleType.MOTORCYCLE_TWO_WHEELS,
    });

    expect(recommendation.vehicleType).toBe(VehicleType.MOTORCYCLE_TWO_WHEELS);
    expect(recommendation.pricePerKmPerPassenger).toBe(1000);
    expect(recommendation.recommendedPricePerSeat).toBe(5000);
    expect(recommendation.recommendedTotalPrice).toBe(5000);
  });

  it('returns every vehicle choice with its respective price', async () => {
    const weatherAwarenessService = {
      getRouteImpact: jest.fn().mockResolvedValue({
        heavyRain: false,
        dataAvailable: true,
        priceMultiplier: 1,
        etaMultiplier: 1,
        evaluatedZoneIds: [],
        affectedZoneIds: [],
      }),
    };
    const service = new TripRequestsService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      weatherAwarenessService as any,
    );
    jest
      .spyOn(service as any, 'resolvePointFromCoordinatesOrAddress')
      .mockResolvedValue({
        type: 'Point',
        coordinates: [15.3136, -4.3073],
      });
    jest
      .spyOn(service as any, 'calculateRouteDistanceMeters')
      .mockResolvedValue(5000);

    const result = await service.getVehicleOptions({
      departureLocation: 'Gombe',
      arrivalLocation: "N'djili",
      numberOfSeats: 2,
    });

    expect(result.options).toEqual([
      expect.objectContaining({
        vehicleType: VehicleType.CAR,
        recommendedPricePerSeat: 2500,
        recommendedTotalPrice: 5000,
      }),
      expect.objectContaining({
        vehicleType: VehicleType.MOTORCYCLE_TWO_WHEELS,
        recommendedPricePerSeat: 5000,
        recommendedTotalPrice: 10000,
      }),
      expect.objectContaining({
        vehicleType: VehicleType.MOTORCYCLE_THREE_WHEELS,
        recommendedPricePerSeat: 5000,
        recommendedTotalPrice: 10000,
      }),
    ]);
  });
});

describe('TripRequestsService optional seat count', () => {
  it('stores one seat when creation omits numberOfSeats', async () => {
    const tripRequestRepository = {
      create: jest.fn().mockImplementation((request) => request),
      save: jest.fn().mockImplementation(async (request) => ({
        ...request,
        id: 'request-1',
      })),
    };
    const service = new TripRequestsService(
      tripRequestRepository as any,
      {} as any,
      {
        findOne: jest.fn().mockResolvedValue({ id: 'passenger-1' }),
      } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    jest
      .spyOn(service as any, 'resolvePointFromCoordinatesOrAddress')
      .mockResolvedValue({
        type: 'Point',
        coordinates: [15.3136, -4.3073],
      });
    jest
      .spyOn(service as any, 'calculateRecommendedPricePerSeat')
      .mockResolvedValue(2500);
    jest
      .spyOn(service as any, 'notifyDriversAboutTripRequest')
      .mockResolvedValue(undefined);
    jest.spyOn(service, 'findOne').mockResolvedValue({ id: 'request-1' } as any);

    const now = Date.now();
    await service.create('passenger-1', {
      departureLocation: 'Gombe',
      arrivalLocation: 'Limete',
      departureDateMin: new Date(now + 30 * 60 * 1000).toISOString(),
      departureDateMax: new Date(now + 90 * 60 * 1000).toISOString(),
      vehicleType: VehicleType.CAR,
    });

    expect(tripRequestRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({ numberOfSeats: 1 }),
    );
  });
});

describe('TripRequestsService vehicle type update', () => {
  const buildService = () => {
    const tripRequest = {
      id: 'request-1',
      passengerId: 'passenger-1',
      departureLocation: 'Gombe',
      arrivalLocation: 'Limete',
      departurePoint: {
        type: 'Point',
        coordinates: [15.3136, -4.3073],
      },
      arrivalPoint: {
        type: 'Point',
        coordinates: [15.403, -4.4075],
      },
      numberOfSeats: 1,
      maxPricePerSeat: 2500,
      vehicleType: VehicleType.CAR,
      status: TripRequestStatus.PENDING,
      driverOffers: [],
    };
    const tripRequestRepository = {
      findOne: jest.fn().mockResolvedValue(tripRequest),
      save: jest.fn().mockImplementation(async (request) => request),
    };
    const service = new TripRequestsService(
      tripRequestRepository as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    jest
      .spyOn(service, 'findOne')
      .mockResolvedValue({ id: tripRequest.id } as any);

    return { service, tripRequest, tripRequestRepository };
  };

  it('changes the vehicle type and recalculates the recommendation when no custom ceiling is sent', async () => {
    const { service, tripRequest, tripRequestRepository } = buildService();
    const calculateRecommendedPricePerSeat = jest
      .spyOn(service as any, 'calculateRecommendedPricePerSeat')
      .mockResolvedValue(5000);

    await service.update('passenger-1', 'request-1', {
      vehicleType: VehicleType.MOTORCYCLE_TWO_WHEELS,
    });

    expect(calculateRecommendedPricePerSeat).toHaveBeenCalledWith(
      tripRequest.departurePoint,
      tripRequest.arrivalPoint,
      VehicleType.MOTORCYCLE_TWO_WHEELS,
      'trip request request-1 update',
    );
    expect(tripRequest.vehicleType).toBe(VehicleType.MOTORCYCLE_TWO_WHEELS);
    expect(tripRequest.maxPricePerSeat).toBe(5000);
    expect(tripRequestRepository.save).toHaveBeenCalledWith(tripRequest);
  });

  it('keeps the passenger custom ceiling when it is sent with the new vehicle type', async () => {
    const { service, tripRequest } = buildService();
    const calculateRecommendedPricePerSeat = jest.spyOn(
      service as any,
      'calculateRecommendedPricePerSeat',
    );

    await service.update('passenger-1', 'request-1', {
      vehicleType: VehicleType.MOTORCYCLE_THREE_WHEELS,
      maxPricePerSeat: 6500,
    });

    expect(calculateRecommendedPricePerSeat).not.toHaveBeenCalled();
    expect(tripRequest.vehicleType).toBe(VehicleType.MOTORCYCLE_THREE_WHEELS);
    expect(tripRequest.maxPricePerSeat).toBe(6500);
  });
});

describe('TripRequestsService motorcycle capacity', () => {
  it.each([
    [VehicleType.MOTORCYCLE_TWO_WHEELS, 3],
    [VehicleType.MOTORCYCLE_THREE_WHEELS, 4],
  ])('rejects an oversized offer for %s', async (type, availableSeats) => {
    const now = Date.now();
    const tripRequestRepository = {
      findOne: jest.fn().mockResolvedValue({
        id: 'request-1',
        passengerId: 'passenger-1',
        departureLocation: 'Gombe',
        arrivalLocation: 'Limete',
        departureDateMin: new Date(now + 30 * 60 * 1000),
        departureDateMax: new Date(now + 90 * 60 * 1000),
        maxPricePerSeat: null,
        numberOfSeats: 1,
        status: TripRequestStatus.PENDING,
        driverOffers: [],
      }),
    };
    const driverOfferRepository = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
    };
    const vehicleRepository = {
      findOne: jest.fn().mockResolvedValue({
        id: 'vehicle-1',
        ownerId: 'driver-1',
        type,
        isActive: true,
      }),
    };
    const service = new TripRequestsService(
      tripRequestRepository as any,
      driverOfferRepository as any,
      { findOne: jest.fn().mockResolvedValue({ id: 'driver-1' }) } as any,
      vehicleRepository as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    await expect(
      service.createDriverOffer('driver-1', 'request-1', {
        proposedDepartureDate: new Date(now + 60 * 60 * 1000).toISOString(),
        pricePerSeat: 1000,
        availableSeats,
        vehicleId: 'vehicle-1',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(driverOfferRepository.create).not.toHaveBeenCalled();
  });

  it('rejects a driver vehicle that differs from the passenger choice', async () => {
    const now = Date.now();
    const tripRequestRepository = {
      findOne: jest.fn().mockResolvedValue({
        id: 'request-1',
        passengerId: 'passenger-1',
        departureLocation: 'Gombe',
        arrivalLocation: 'Limete',
        departureDateMin: new Date(now + 30 * 60 * 1000),
        departureDateMax: new Date(now + 90 * 60 * 1000),
        maxPricePerSeat: null,
        numberOfSeats: 1,
        vehicleType: VehicleType.CAR,
        status: TripRequestStatus.PENDING,
        driverOffers: [],
      }),
    };
    const driverOfferRepository = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
    };
    const vehicleRepository = {
      findOne: jest.fn().mockResolvedValue({
        id: 'vehicle-1',
        ownerId: 'driver-1',
        type: VehicleType.MOTORCYCLE_TWO_WHEELS,
        isActive: true,
      }),
    };
    const service = new TripRequestsService(
      tripRequestRepository as any,
      driverOfferRepository as any,
      { findOne: jest.fn().mockResolvedValue({ id: 'driver-1' }) } as any,
      vehicleRepository as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    await expect(
      service.createDriverOffer('driver-1', 'request-1', {
        proposedDepartureDate: new Date(now + 60 * 60 * 1000).toISOString(),
        pricePerSeat: 1000,
        availableSeats: 1,
        vehicleId: 'vehicle-1',
      }),
    ).rejects.toThrow('Le passager a choisi le type de véhicule Voiture');

    expect(driverOfferRepository.create).not.toHaveBeenCalled();
  });
});

describe('TripRequestsService unaccepted request expiration', () => {
  const buildService = (tripRequestRepository: Record<string, jest.Mock>) =>
    new TripRequestsService(
      tripRequestRepository as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

  it('keeps an old request visible until twelve hours after the end of its departure window', async () => {
    const now = Date.now();
    const request = {
      id: 'request-recent',
      status: TripRequestStatus.PENDING,
      createdAt: new Date(now - 30 * 24 * 60 * 60 * 1000),
      departureDateMin: new Date(now - 13 * 60 * 60 * 1000),
      departureDateMax: new Date(now - (12 * 60 - 1) * 60 * 1000),
      driverOffers: [],
    };
    const tripRequestRepository = {
      find: jest.fn().mockResolvedValue([request]),
      update: jest.fn(),
    };
    const service = buildService(tripRequestRepository);
    jest
      .spyOn(service as any, 'sanitizeTripRequest')
      .mockImplementation(async (tripRequest: any) => ({
        id: tripRequest.id,
        status: tripRequest.status,
      }));

    const result = await service.findAll();

    expect(result).toEqual([
      expect.objectContaining({
        id: 'request-recent',
        status: TripRequestStatus.PENDING,
      }),
    ]);
    expect(tripRequestRepository.update).not.toHaveBeenCalled();
    expect(
      tripRequestRepository.find.mock.calls[0][0].where,
    ).not.toHaveProperty('createdAt');
  });

  it('expires pending and offers-received requests after twelve hours unless a driver was accepted', async () => {
    const now = Date.now();
    const unansweredRequest = {
      id: 'request-unanswered',
      status: TripRequestStatus.PENDING,
      createdAt: new Date(now - 30 * 24 * 60 * 60 * 1000),
      departureDateMin: new Date(now - 13 * 60 * 60 * 1000 - 1),
      departureDateMax: new Date(now - 12 * 60 * 60 * 1000 - 1),
      driverOffers: [],
    };
    const unacceptedOfferRequest = {
      id: 'request-offer-not-accepted',
      status: TripRequestStatus.OFFERS_RECEIVED,
      createdAt: new Date(now - 30 * 24 * 60 * 60 * 1000),
      departureDateMin: new Date(now - 30 * 24 * 60 * 60 * 1000),
      departureDateMax: new Date(now - 29 * 24 * 60 * 60 * 1000),
      driverOffers: [
        { id: 'offer-1', status: DriverOfferStatus.PENDING },
      ],
    };
    const acceptedRequest = {
      id: 'request-accepted',
      status: TripRequestStatus.OFFERS_RECEIVED,
      createdAt: new Date(now - 30 * 24 * 60 * 60 * 1000),
      departureDateMin: new Date(now - 30 * 24 * 60 * 60 * 1000),
      departureDateMax: new Date(now - 29 * 24 * 60 * 60 * 1000),
      driverOffers: [
        { id: 'offer-2', status: DriverOfferStatus.ACCEPTED },
      ],
    };
    const freshOfferRequest = {
      id: 'request-fresh-offer',
      status: TripRequestStatus.OFFERS_RECEIVED,
      createdAt: new Date(now - 30 * 24 * 60 * 60 * 1000),
      departureDateMin: new Date(now - 2 * 60 * 60 * 1000),
      departureDateMax: new Date(now - 60 * 60 * 1000),
      driverOffers: [
        { id: 'offer-3', status: DriverOfferStatus.PENDING },
      ],
    };
    const tripRequestRepository = {
      find: jest.fn().mockResolvedValue([
        unansweredRequest,
        unacceptedOfferRequest,
        acceptedRequest,
        freshOfferRequest,
      ]),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    const service = buildService(tripRequestRepository);
    jest
      .spyOn(service as any, 'sanitizeTripRequest')
      .mockImplementation(async (tripRequest: any) => ({
        id: tripRequest.id,
        status: tripRequest.status,
      }));

    const result = await service.findAll();

    expect(unansweredRequest.status).toBe(TripRequestStatus.EXPIRED);
    expect(unacceptedOfferRequest.status).toBe(TripRequestStatus.EXPIRED);
    expect(acceptedRequest.status).toBe(TripRequestStatus.OFFERS_RECEIVED);
    expect(freshOfferRequest.status).toBe(TripRequestStatus.OFFERS_RECEIVED);
    expect(result).toEqual([
      expect.objectContaining({
        id: 'request-fresh-offer',
        status: TripRequestStatus.OFFERS_RECEIVED,
      }),
    ]);
    expect(tripRequestRepository.update).toHaveBeenCalledTimes(2);
    expect(tripRequestRepository.update).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'request-unanswered',
      }),
      { status: TripRequestStatus.EXPIRED },
    );
    expect(tripRequestRepository.update).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'request-offer-not-accepted',
      }),
      { status: TripRequestStatus.EXPIRED },
    );
  });

  it('rejects a driver response once the twelve-hour deadline has passed', async () => {
    const now = Date.now();
    const tripRequest = {
      id: 'request-expired',
      passengerId: 'passenger-1',
      status: TripRequestStatus.PENDING,
      createdAt: new Date(now - 30 * 24 * 60 * 60 * 1000),
      departureDateMin: new Date(now - 13 * 60 * 60 * 1000 - 1),
      departureDateMax: new Date(now - 12 * 60 * 60 * 1000 - 1),
      driverOffers: [],
    };
    const tripRequestRepository = {
      findOne: jest.fn().mockResolvedValue(tripRequest),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    const driverOfferRepository = {
      findOne: jest.fn(),
      create: jest.fn(),
    };
    const service = new TripRequestsService(
      tripRequestRepository as any,
      driverOfferRepository as any,
      { findOne: jest.fn().mockResolvedValue({ id: 'driver-1' }) } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    await expect(
      service.createDriverOffer('driver-1', tripRequest.id, {
        proposedDepartureDate: new Date(now + 60 * 60 * 1000).toISOString(),
        pricePerSeat: 1000,
        availableSeats: 1,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(tripRequest.status).toBe(TripRequestStatus.EXPIRED);
    expect(driverOfferRepository.create).not.toHaveBeenCalled();
  });
});
