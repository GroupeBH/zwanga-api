import { TripRequestsService } from './trip-requests.service';
import { TripRequestStatus } from './entities/trip-request.entity';

describe('admin request batch projection', () => {
  function fixture(count = 100) {
    const rows = Array.from({ length: count }, (_, i) => ({
      id: `r${i}`,
      passengerId: 'passenger',
      passenger: { id: 'passenger' },
      selectedDriver: null,
      selectedVehicle: null,
      driverOffers: [
        {
          id: `o${i}`,
          driverId: 'driver',
          driver: { id: 'driver' },
          status: 'pending',
        },
      ],
      status: TripRequestStatus.PENDING,
      departureDateMax: new Date(Date.now() + 3600000),
      sequentialDispatch: false,
    }));
    const repository = {
      find: jest.fn(async (query: any) =>
        rows.filter((r) => query.where.id._value.includes(r.id)),
      ),
      manager: { query: jest.fn().mockResolvedValue([]) },
    };
    const subscriptions = {
      getPremiumFeaturesForUsers: jest.fn(
        async (ids: string[]) =>
          new Map(
            ids.map((id) => [
              id,
              { isPremium: false, premiumBadgeEnabled: false },
            ]),
          ),
      ),
      getPremiumOverview: jest.fn(),
    };
    const service = Object.assign(
      Object.create(TripRequestsService.prototype),
      {
        tripRequestRepository: repository,
        subscriptionsService: subscriptions,
        fileUploadService: {},
        logger: { debug: jest.fn() },
        UNACCEPTED_REQUEST_EXPIRATION_MS: 0,
      },
    ) as TripRequestsService;
    return { service, rows, repository, subscriptions };
  }
  it('uses one relational read and one subscription read for a hundred rows', async () => {
    const f = fixture();
    const ids = f.rows.map((r) => r.id).reverse();
    const result = await f.service.findForAdminBatch(ids);
    expect(result.map((r) => r.id)).toEqual(ids);
    expect(f.repository.find).toHaveBeenCalledTimes(1);
    expect(f.subscriptions.getPremiumFeaturesForUsers).toHaveBeenCalledTimes(1);
    expect(f.subscriptions.getPremiumOverview).not.toHaveBeenCalled();
    expect(result[0].driverOffers).toHaveLength(1);
    expect(result[0].passenger).not.toHaveProperty('phone');
  });
  it('batches large histories, preserves order and ignores concurrent removals', async () => {
    const f = fixture(201);
    expect(
      await f.service.findForAdminBatch([
        ...f.rows.map((r) => r.id),
        'deleted',
      ]),
    ).toHaveLength(201);
    expect(f.repository.find).toHaveBeenCalledTimes(3);
  });
  it('makes no database call for an empty page', async () => {
    const f = fixture();
    expect(await f.service.findForAdminBatch([])).toEqual([]);
    expect(f.repository.find).not.toHaveBeenCalled();
  });
  it('fetches response windows and target refusals once per batch', async () => {
    const f = fixture(2);
    Object.assign(f.rows[0], {
      sequentialDispatch: true,
      targetDriverId: 'target',
    });
    f.repository.manager.query
      .mockResolvedValueOnce([
        {
          requestId: 'r0',
          phase: 'passenger',
          expiresAt: new Date(),
          serverNow: new Date(),
        },
      ])
      .mockResolvedValueOnce([{ requestId: 'r0' }]);
    const result = await f.service.findForAdminBatch(['r0', 'r1']);
    expect(result[0].responseWindow?.phase).toBe('passenger');
    expect(result[0].targetDriverDeclined).toBe(true);
    expect(f.repository.manager.query).toHaveBeenCalledTimes(2);
  });
});
