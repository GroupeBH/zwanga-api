import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { User, UserRole } from '../users/entities/user.entity';
import { DriverOffer, DriverOfferStatus } from './entities/driver-offer.entity';
import { TripRequest, TripRequestStatus } from './entities/trip-request.entity';
import { TripRequestsService } from './trip-requests.service';
import { TripRequestRecoveryService } from './trip-request-recovery.service';

function buildService() {
  const passenger = Object.assign(new User(), {
    id: 'passenger',
    role: UserRole.PASSENGER,
    firstName: 'Alice',
    lastName: 'Test',
    phone: '+243000000001',
  });
  const driver = Object.assign(new User(), {
    id: 'driver',
    role: UserRole.DRIVER,
    phone: '+243000000002',
  });
  const otherDriver = Object.assign(new User(), {
    id: 'other-driver',
    role: UserRole.DRIVER,
    phone: '+243000000003',
  });
  const request = Object.assign(new TripRequest(), {
    id: 'request',
    passengerId: passenger.id,
    passenger,
    status: TripRequestStatus.OFFERS_RECEIVED,
    selectedDriverId: null,
    tripId: null,
    departureLocation: '123 avenue privée',
    arrivalLocation: '456 rue privée',
    departureReference: 'Porte 12',
    arrivalReference: 'Appartement 34',
    departurePoint: { type: 'Point', coordinates: [15.3123456, -4.3219876] },
    arrivalPoint: { type: 'Point', coordinates: [15.2876543, -4.3987654] },
    description: 'Un bagage à transporter',
    departureDateMin: new Date(Date.now() + 3600_000),
    departureDateMax: new Date(Date.now() + 7200_000),
    numberOfSeats: 1,
  });
  const offers = [driver, otherDriver].map((user) =>
    Object.assign(new DriverOffer(), {
      id: `offer-${user.id}`,
      driverId: user.id,
      driver: user,
      tripRequestId: request.id,
      tripRequest: request,
      status: DriverOfferStatus.PENDING,
      pricePerSeat: 2500,
      departureReference: request.departureReference,
      arrivalReference: request.arrivalReference,
      departurePoint: request.departurePoint,
      arrivalPoint: request.arrivalPoint,
      message: 'Je peux vous prendre en charge',
    }),
  );
  request.driverOffers = offers;
  const requests = {
    find: jest.fn().mockResolvedValue([request]),
    findOne: jest.fn().mockResolvedValue(request),
    update: jest.fn(),
  };
  const offerRepository = { find: jest.fn().mockResolvedValue([offers[0]]) };
  const users = {
    findOne: jest.fn(({ where }: { where: { id: string } }) =>
      Promise.resolve(
        [passenger, driver, otherDriver].find((user) => user.id === where.id) ??
          Object.assign(new User(), { id: where.id, role: UserRole.PASSENGER }),
      ),
    ),
    find: jest
      .fn()
      .mockResolvedValue([{ id: driver.id, fcmToken: 'test-token' }]),
  };
  const notifications = { sendToMultiple: jest.fn().mockResolvedValue(true) };
  const dependencies = [
    requests,
    offerRepository,
    users,
    {},
    {},
    notifications,
    {},
    {},
    {},
    {
      getPremiumOverview: jest
        .fn()
        .mockResolvedValue({ isPremium: false, premiumBadgeEnabled: false }),
    },
    {},
    {},
  ] as unknown as ConstructorParameters<typeof TripRequestsService>;
  const service = new TripRequestsService(...dependencies);
  const accept = () => {
    request.selectedDriverId = driver.id;
    request.selectedDriver = driver;
    request.status = TripRequestStatus.DRIVER_SELECTED;
    offers[0].status = DriverOfferStatus.ACCEPTED;
    offers[1].status = DriverOfferStatus.REJECTED;
  };
  return {
    service,
    request,
    offers,
    driver,
    passenger,
    requests,
    users,
    notifications,
    accept,
  };
}

describe('Trip request privacy', () => {
  it('keeps exact addresses and map points for drivers, without phones or competing offers', async () => {
    const { service, request } = buildService();
    const [result] = await service.findAll('driver');
    expect(result).toMatchObject({
      departureLocation: request.departureLocation,
      arrivalLocation: request.arrivalLocation,
      departureCoordinates: [15.3123456, -4.3219876],
      arrivalCoordinates: [15.2876543, -4.3987654],
      departureReference: request.departureReference,
      arrivalReference: request.arrivalReference,
      description: request.description,
    });
    expect(result.passenger).not.toHaveProperty('phone');
    expect(result.driverOffers.map((offer) => offer.id)).toEqual([
      'offer-driver',
    ]);
    expect(result.driverOffers[0]).toMatchObject({
      departureCoordinates: request.departurePoint?.coordinates,
      departureReference: request.departureReference,
    });
    expect(JSON.stringify(result)).not.toContain('+243');
    expect(request.departurePoint?.coordinates).toEqual([
      15.3123456, -4.3219876,
    ]);
    expect(request.driverOffers).toHaveLength(2);
  });

  it.each(['passenger', 'stranger', ''])(
    'denies listing and my-offers to %s',
    async (viewer) => {
      const { service, requests } = buildService();
      await expect(service.findAll(viewer)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      await expect(service.findByDriver(viewer)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(requests.find).not.toHaveBeenCalled();
    },
  );

  it('does not allow the detail route to bypass the list privacy rules', async () => {
    const { service, request } = buildService();
    const result = await service.findOne('request', 'driver');
    expect(result.departureCoordinates).toEqual(
      request.departurePoint?.coordinates,
    );
    expect(result.passenger).not.toHaveProperty('phone');
    expect(result.driverOffers).toHaveLength(1);
    await expect(service.findOne('request', 'stranger')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(service.findOne('request')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('preserves the passenger’s own exact locations without disclosing drivers’ phones', async () => {
    const { service, request } = buildService();
    const result = await service.findOne('request', 'passenger');
    const [ownRequest] = await service.findByPassenger('passenger');
    for (const own of [result, ownRequest]) {
      expect(own.departureLocation).toBe(request.departureLocation);
      expect(own.departureCoordinates).toEqual(
        request.departurePoint?.coordinates,
      );
      expect(own.description).toBe(request.description);
      expect(own.driverOffers).toHaveLength(2);
      own.driverOffers.forEach((offer) =>
        expect(offer.driver).not.toHaveProperty('phone'),
      );
    }
  });

  it('shares exact locations and contacts only with the owner and selected driver after acceptance', async () => {
    const { service, request, accept, passenger, driver } = buildService();
    accept();
    for (const viewer of ['driver', 'passenger']) {
      const result = await service.findOne('request', viewer);
      expect(result.passenger.phone).toBe(passenger.phone);
      expect(result.selectedDriver?.phone).toBe(driver.phone);
      expect(result.departureCoordinates).toEqual(
        request.departurePoint?.coordinates,
      );
      expect(result.driverOffers[0].driver.phone).toBe(driver.phone);
    }
    await expect(
      service.findOne('request', 'other-driver'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(await service.findAll('other-driver')).toEqual([]);
  });

  it('only reveals the accepted driver’s phone in the passenger’s offers endpoint', async () => {
    const { service, accept, driver } = buildService();
    const before = await service.getOffersForTripRequest(
      'request',
      'passenger',
    );
    before.forEach((offer) => expect(offer.driver).not.toHaveProperty('phone'));
    accept();
    const after = await service.getOffersForTripRequest('request', 'passenger');
    expect(after[0].driver.phone).toBe(driver.phone);
    expect(after[1].driver).not.toHaveProperty('phone');
    await expect(
      service.getOffersForTripRequest('request'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.getOffersForTripRequest('request', 'driver'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it.each([
    DriverOfferStatus.PENDING,
    DriverOfferStatus.REJECTED,
    DriverOfferStatus.CANCELLED,
  ])(
    'masks the passenger in my-offers when the offer is %s',
    async (status) => {
      const { service, offers, request } = buildService();
      offers[0].status = status;
      request.selectedDriverId = 'other-driver';
      const [result] = await service.findByDriver('driver');
      expect(result.tripRequest.passenger).not.toHaveProperty('phone');
      expect(JSON.stringify(result)).not.toContain('+243');
    },
  );

  it('reveals the passenger in my-offers after acceptance, but revokes access on release', async () => {
    const { service, request, offers, accept, passenger } = buildService();
    accept();
    const [accepted] = await service.findByDriver('driver');
    expect(accepted.tripRequest.passenger.phone).toBe(passenger.phone);
    expect(accepted.tripRequest.departureLocation).toEqual(
      request.departureLocation,
    );
    request.selectedDriverId = null;
    request.selectedDriver = null;
    request.status = TripRequestStatus.PENDING;
    offers[0].status = DriverOfferStatus.CANCELLED;
    const [released] = await service.findByDriver('driver');
    expect(released.tripRequest.passenger).not.toHaveProperty('phone');
    expect(
      (await service.findOne('request', 'driver')).passenger,
    ).not.toHaveProperty('phone');
  });

  it('does not trust an old accepted offer when a different driver is selected', async () => {
    const { service, request, accept } = buildService();
    accept();
    request.selectedDriverId = 'other-driver';
    await expect(service.findOne('request', 'driver')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    const [result] = await service.findByDriver('driver');
    expect(result.tripRequest.passenger).not.toHaveProperty('phone');
  });

  it.each([TripRequestStatus.EXPIRED, TripRequestStatus.CANCELLED])(
    'hides unaccepted %s requests from other drivers',
    async (status) => {
      const { service, request } = buildService();
      request.status = status;
      await expect(service.findOne('request', 'driver')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(
        (await service.findOne('request', 'passenger')).departureLocation,
      ).toBe(request.departureLocation);
    },
  );

  it('keeps missing coordinates null instead of geocoding a precise address in the response', async () => {
    const { service, request } = buildService();
    request.departurePoint = null;
    request.arrivalPoint = null;
    const result = await service.findOne('request', 'driver');
    expect(result.departureCoordinates).toBeNull();
    expect(result.arrivalCoordinates).toBeNull();
    expect(result.departureLocation).toBe(request.departureLocation);
  });

  it('omits private addresses from both new-request and reopened-request broadcasts', async () => {
    const { service, request, users, notifications } = buildService();
    await service['notifyDriversAboutTripRequest'](request);
    const recovery = new TripRequestRecoveryService(
      ...([
        {},
        users,
        { ...notifications, sendNotificationToUser: jest.fn() },
      ] as unknown as ConstructorParameters<typeof TripRequestRecoveryService>),
    );
    await recovery['notifyReopenedRequest'](request);
    expect(notifications.sendToMultiple).toHaveBeenCalledTimes(2);
    for (const call of notifications.sendToMultiple.mock.calls) {
      expect(JSON.stringify(call)).not.toContain(request.departureLocation);
      expect(JSON.stringify(call)).not.toContain(request.arrivalLocation);
      expect(JSON.stringify(call)).not.toContain('+243');
    }
    const queries = users.find.mock.calls as unknown[][];
    expect(queries[0][0]).toMatchObject({ where: { role: UserRole.DRIVER } });
  });
});
