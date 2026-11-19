import { TripRequestsService } from './trip-requests.service';

describe('request read budgets', () => {
  it.each([1, 20, 100])(
    'deduplicates subscription reads for %i requests, preserving the map for serialization',
    async (count) => {
      const rows = Array.from({ length: count }, (_, i) => ({
        id: `r${i}`,
        passenger: { id: 'passenger' },
        selectedDriver: { id: 'driver' },
        driverOffers: [{ driver: { id: 'driver' } }],
      }));
      const subscriptions = {
        getPremiumOverview: jest.fn(),
        getPremiumFeaturesForUsers: jest.fn(
          async (ids) =>
            new Map(
              ids.map((id) => [
                id,
                {
                  isPremium: id === 'driver',
                  premiumBadgeEnabled: id === 'driver',
                },
              ]),
            ),
        ),
      };
      const service: any = Object.assign(
        Object.create(TripRequestsService.prototype),
        {
          logger: { debug: jest.fn() },
          tripRequestRepository: { find: jest.fn().mockResolvedValue(rows) },
          subscriptionsService: subscriptions,
          expireRequests: jest.fn(),
          sanitizeTripRequest: jest.fn(async (row) => row),
        },
      );
      expect(
        await service.findByPassenger('owner', false, { page: 2, limit: 20 }),
      ).toEqual(rows);
      expect(service.tripRequestRepository.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { passengerId: 'owner' },
          take: 20,
          skip: 20,
          order: { createdAt: 'DESC', id: 'DESC' },
        }),
      );
      expect(subscriptions.getPremiumFeaturesForUsers).toHaveBeenCalledTimes(1);
      expect(
        new Set(subscriptions.getPremiumFeaturesForUsers.mock.calls[0][0]),
      ).toEqual(new Set(['driver', 'passenger']));
      expect(subscriptions.getPremiumOverview).not.toHaveBeenCalled();
      const features = service.sanitizeTripRequest.mock.calls[0][3];
      expect(features.get('driver').isPremium).toBe(true);
      expect(features.get('passenger').isPremium).toBe(false);
      expect(
        service.sanitizeTripRequest.mock.calls.every(
          (call) => call[3] === features,
        ),
      ).toBe(true);
    },
  );

  it('bounds unique-user lookup batches, including offer drivers', async () => {
    const getPremiumFeaturesForUsers = jest.fn(
      async (ids) => new Map(ids.map((id) => [id, { isPremium: false }])),
    );
    const service: any = Object.assign(
      Object.create(TripRequestsService.prototype),
      {
        subscriptionsService: { getPremiumFeaturesForUsers },
      },
    );
    const offers = Array.from({ length: 205 }, (_, i) => ({
      driver: { id: `d${i}` },
    }));
    expect((await service.loadRequestPremium([], offers)).size).toBe(205);
    expect(
      getPremiumFeaturesForUsers.mock.calls.map(([ids]) => ids.length),
    ).toEqual([100, 100, 5]);
  });

  it.each(['recommendPrice', 'getVehicleOptions'])(
    '%s resolves both independent endpoints concurrently',
    async (method) => {
      const service: any = Object.create(TripRequestsService.prototype);
      let departure!: (value: any) => void;
      service.resolvePointFromCoordinatesOrAddress = jest
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              departure = resolve;
            }),
        )
        .mockResolvedValueOnce(null);
      service.calculatePricing = jest
        .fn()
        .mockRejectedValue(new Error('stop before pricing'));
      const result = service[method]({
        departureLocation: 'A',
        arrivalLocation: 'B',
      });
      expect(
        service.resolvePointFromCoordinatesOrAddress,
      ).toHaveBeenCalledTimes(2);
      departure(null);
      await expect(result).rejects.toThrow('stop before pricing');
      expect(service.calculatePricing).toHaveBeenCalledTimes(1);
    },
  );
});
