import { TripRequestsService } from './trip-requests.service';
import { TripRequestsController } from './trip-requests.controller';
import { activeRequestWhere } from '../common/activity-read-policy';

describe('request activity read without unbounded history hydration', () => {
  beforeEach(() => jest.useFakeTimers({ now: new Date('2026-10-21T12:00:00Z') }));
  afterEach(() => jest.useRealTimers());

  it('uses the same scope as the activity summary, without limiting unfinished requests', async () => {
    const rows = [{ id: 'a' }, { id: 'b' }];
    const repository = { find: jest.fn().mockResolvedValue(rows) };
    const dependencies = [repository, ...Array.from({ length: 11 }, () => ({}))] as unknown as ConstructorParameters<typeof TripRequestsService>;
    const service = new TripRequestsService(...dependencies);
    const expire = jest.spyOn(service as any, 'expireRequests').mockResolvedValue(undefined);
    const sanitize = jest.spyOn(service as any, 'sanitizeTripRequest').mockImplementation(async value => value);
    expect(await service.findByPassenger('owner', true)).toEqual(rows);
    expect(repository.find).toHaveBeenLastCalledWith({
      where: activeRequestWhere('owner'),
      relations: ['passenger', 'targetDriver', 'selectedDriver', 'selectedVehicle', 'driverOffers', 'driverOffers.driver', 'driverOffers.vehicle'],
      order: { createdAt: 'DESC' },
    });
    expect(expire).toHaveBeenCalledWith(rows);
    expect(sanitize).toHaveBeenCalledWith(rows[0], 'owner');
    expect(sanitize).toHaveBeenCalledWith(rows[1], 'owner');
    await service.findByPassenger('owner');
    expect(repository.find.mock.calls.at(-1)?.[0].where).toEqual({ passengerId: 'owner' });
  });

  it('selects activity only explicitly and always obtains the owner from the authenticated request', async () => {
    const findByPassenger = jest.fn().mockResolvedValue([]);
    const controller = new TripRequestsController({ findByPassenger } as unknown as TripRequestsService);
    const req = { user: { userId: 'owner' } };
    await controller.findMyRequests(req, 'activity');
    expect(findByPassenger).toHaveBeenLastCalledWith('owner', true);
    for (const scope of [undefined, 'other-account', 'history']) {
      await controller.findMyRequests(req, scope);
      expect(findByPassenger).toHaveBeenLastCalledWith('owner', false);
    }
  });
});
