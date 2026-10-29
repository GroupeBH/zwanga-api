import { FindOperator, In, IsNull, MoreThan } from 'typeorm';
import { TripRequestsService } from './trip-requests.service';
import { TripRequestStatus } from './entities/trip-request.entity';
import { DriverOfferStatus } from './entities/driver-offer.entity';
import { UNACCEPTED_REQUEST_EXPIRATION_MS } from './request-edit-policy';

const now = new Date('2026-10-19T12:00:00.000Z');
const cutoff = new Date(now.getTime() - UNACCEPTED_REQUEST_EXPIRATION_MS);
const request = (extra = {}) => ({
  id: '00000000-0000-4000-8000-000000000001',
  passengerId: 'passenger',
  status: TripRequestStatus.PENDING,
  selectedDriverId: null,
  tripId: null,
  immediateDispatch: false,
  driverOffers: [],
  departureDateMax: new Date(cutoff.getTime() + 1),
  ...extra,
});
function fixture(rows: ReturnType<typeof request>[]) {
  const query: any = {};
  for (const method of [
    'where',
    'andWhere',
    'clone',
    'select',
    'addSelect',
    'orderBy',
    'addOrderBy',
    'limit',
  ])
    query[method] = jest.fn(() => query);
  query.getCount = jest.fn().mockResolvedValue(rows.length);
  query.getRawMany = jest
    .fn()
    .mockResolvedValue(
      rows.map((row) => ({ id: row.id, at: '2026-10-19T08:00:00.000000' })),
    );
  const repository: any = {
    find: jest.fn().mockResolvedValue(rows),
    update: jest.fn().mockResolvedValue({ affected: 0 }),
    createQueryBuilder: jest.fn(() => query),
  };
  repository.manager = {
    transaction: jest.fn((work) => work({ getRepository: () => repository })),
  };
  const dependencies = [
    repository,
    ...Array.from({ length: 11 }, () => ({})),
  ] as unknown as ConstructorParameters<typeof TripRequestsService>;
  const service = new TripRequestsService(...dependencies);
  jest.spyOn(service as any, 'assertDriverViewer').mockResolvedValue(undefined);
  jest
    .spyOn(service as any, 'sanitizeTripRequest')
    .mockImplementation(async (value) => value);
  return { service, repository, query };
}

describe('Search/Home request availability independent of expiration persistence', () => {
  beforeEach(() => jest.useFakeTimers({ now }));
  afterEach(() => jest.useRealTimers());

  it('filters deadlines in the legacy TypeORM query and preserves the existing three-hour grace period', async () => {
    const row = request(),
      { service, repository } = fixture([row]);
    expect(await service.findAll('driver')).toEqual([row]);
    expect(repository.find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: expect.any(FindOperator),
          status: In([
            TripRequestStatus.PENDING,
            TripRequestStatus.OFFERS_RECEIVED,
          ]),
          departureDateMax: MoreThan(cutoff),
          selectedDriverId: IsNull(),
          tripId: IsNull(),
        },
      }),
    );
    expect(repository.update).not.toHaveBeenCalled();
  });

  it.each([TripRequestStatus.PENDING, TripRequestStatus.OFFERS_RECEIVED])(
    'hides elapsed %s snapshots even if the conditional expiration update loses a race',
    async (status) => {
      const row = request({ status, departureDateMax: cutoff });
      const { service, repository } = fixture([row]);
      expect(await service.findAll('driver')).toEqual([]);
      expect(repository.update).toHaveBeenCalledTimes(1);
      expect(row.status).toBe(status); // Lost update must not mutate the snapshot.
    },
  );

  it.each([
    { status: TripRequestStatus.EXPIRED },
    { status: TripRequestStatus.CANCELLED },
    { selectedDriverId: 'driver' },
    { tripId: 'trip' },
    { driverOffers: [{ status: DriverOfferStatus.ACCEPTED }] },
    { departureDateMax: new Date('invalid') },
  ])('does not expose an unavailable request: %j', async (extra) => {
    expect(await fixture([request(extra)]).service.findAll('driver')).toEqual(
      [],
    );
  });

  it('rechecks expiration after paginated hydration even when persistence did not change the status', async () => {
    const { service, query } = fixture([request({ departureDateMax: cutoff })]);
    const result = await service.findRequestPage('driver', false, {
      limit: 20,
    });
    expect(result.data).toEqual([]);
    expect(query.andWhere).toHaveBeenCalledWith(
      'request.departureDateMax > :cutoff',
      { cutoff },
    );
    expect((service as any).sanitizeTripRequest).not.toHaveBeenCalled();
  });

  it.each([false, true])('lists available requests without an invitation (immediate=%s)', async immediateDispatch => {
    const row = request({ immediateDispatch, sequentialDispatch: true });
    const { service, query } = fixture([row]);
    expect(await service.findAll('driver')).toEqual([row]);
    expect((await service.findRequestPage('driver', false, { limit: 20 })).data).toEqual([row]);
    const filters = query.andWhere.mock.calls.map(([sql]) => sql).join(' ');
    expect(filters).not.toContain('trip_request_dispatch_offers');
    expect(filters).not.toContain('immediateDispatch');
  });

  it('keeps expired requests in personal history and accepts genuinely reprogrammed requests', async () => {
    const row = request({ status: TripRequestStatus.EXPIRED }),
      { service } = fixture([row]);
    expect(await service.findByPassenger('passenger')).toEqual([row]);
    expect((await service.findRequestPage('passenger', true, {})).data).toEqual(
      [row],
    );
    row.status = TripRequestStatus.PENDING;
    row.departureDateMax = new Date(now.getTime() + 3600000);
    expect(await service.findAll('driver')).toEqual([row]);
  });
});
