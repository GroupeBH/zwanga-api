import { BadRequestException } from '@nestjs/common';
import { VehicleType } from '../vehicles/entities/vehicle.entity';
import { TripRequestStatus } from './entities/trip-request.entity';
import { TripRequestsService } from './trip-requests.service';

describe('TripRequestsService weather-aware recommended price', () => {
  it('applies the heavy-rain coefficient after the distance pricing tiers', async () => {
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
    });

    expect(recommendation.recommendedPricePerSeat).toBe(19500);
    expect(recommendation.recommendedTotalPrice).toBe(39000);
    expect(recommendation.weatherImpact.priceMultiplier).toBe(1.3);
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
});
