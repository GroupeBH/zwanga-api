import { requestPageIds, offerPageIds } from './request-pages';
import { historyContext } from '../common/history-page';
import { TripRequestsService } from './trip-requests.service';
import { TripRequestStatus } from './entities/trip-request.entity';
import { TripRequestsController } from './trip-requests.controller';

const rows = [3, 2, 1].map(id => ({ id: `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`, at: '2026-10-18T12:00:00.123456' }));
function fixture() {
  const query: any = {};
  for (const method of ['where', 'andWhere', 'leftJoin', 'clone', 'select', 'addSelect', 'orderBy', 'addOrderBy', 'limit']) query[method] = jest.fn(() => query);
  query.getCount = jest.fn().mockResolvedValue(3);
  query.getRawMany = jest.fn().mockResolvedValue(rows);
  return { query, repository: { createQueryBuilder: jest.fn(() => query), find: jest.fn() } as any };
}
describe('request/offer cursor pages', () => {
  it('bounds request IDs before relation hydration and excludes accepted/immediate/expired/public self requests', async () => {
    const f = fixture(); const page = await requestPageIds(f.repository, 'driver', false, { limit: 2 });
    expect(page.ids).toEqual(rows.slice(0, 2).map(row => row.id)); expect(page.total).toBe(3);
    expect(f.query.limit).toHaveBeenCalledWith(3);
    const conditions = f.query.andWhere.mock.calls.map(([sql]) => sql).join(' ');
    expect(conditions).toContain('immediateDispatch = false'); expect(conditions).toContain('selectedDriverId IS NULL');
    expect(conditions).toContain('trip_request_driver_refusals'); expect(conditions).toContain('NOT EXISTS'); expect(conditions).toContain('departureDateMax > :cutoff');
    const context = historyContext({ before: page.nextCursor! }, 'requests-available');
    expect(context.cursor?.at).toBe(rows[1].at);
    expect(() => historyContext({ before: page.nextCursor! }, 'requests-own')).toThrow();
    expect(f.query.leftJoin).not.toHaveBeenCalled();
  });
  it('scopes personal requests and offers to their respective authenticated owner', async () => {
    const f = fixture(); await requestPageIds(f.repository, 'owner', true, { limit: 20 });
    expect(f.query.andWhere).toHaveBeenCalledWith('request.passengerId = :userId', { userId: 'owner' });
    await offerPageIds(f.repository, 'driver', { limit: 20 });
    expect(f.query.where).toHaveBeenCalledWith('offer.driverId = :driverId', { driverId: 'driver' });
  });
  it('rejects malformed cursors before reading and keeps null cursors on the last page', async () => {
    const f = fixture(); await expect(requestPageIds(f.repository, 'owner', true, { before: 'bad' })).rejects.toThrow();
    expect(f.repository.createQueryBuilder).not.toHaveBeenCalled();
    f.query.getRawMany.mockResolvedValue([]);
    expect((await requestPageIds(f.repository, 'owner', true, {})).nextCursor).toBeNull();
  });
  it('searches every word across addresses/references with bound and escaped literals', async () => {
    const f = fixture(); await requestPageIds(f.repository, 'owner', true, { search: ' École   50%_! école' });
    const terms = f.query.andWhere.mock.calls.filter(([sql]) => sql.includes('LIKE :requestTerm'));
    expect(terms).toHaveLength(2);
    expect(terms[0][0]).toContain('request.departureReference');
    expect(terms[0][0]).toContain('request.arrivalReference');
    expect(terms[0][1]).toEqual({ requestTerm0: '%ecole%' });
    expect(terms[1][1]).toEqual({ requestTerm1: '%50!%!_!!%' });
    expect(terms[1][0]).not.toContain('50%');
  });
  it('rechecks a raced acceptance after loading IDs and still advances the cursor', async () => {
    const f = fixture(), service = Object.create(TripRequestsService.prototype);
    service.tripRequestRepository = f.repository;
    service.assertDriverViewer = jest.fn(); service.expireRequests = jest.fn();
    service.sanitizeTripRequest = jest.fn(async request => ({ id: request.id }));
    f.repository.find.mockResolvedValue([{ id: rows[0].id, status: TripRequestStatus.DRIVER_SELECTED, selectedDriverId: 'other', driverOffers: [] }]);
    const page = await service.findRequestPage('driver', false, { limit: 2 });
    expect(page.data).toEqual([]); expect(page.nextCursor).not.toBeNull();
    expect(service.sanitizeTripRequest).not.toHaveBeenCalled();
  });
  it('controller never accepts a caller-supplied owner for pages', async () => {
    const service: any = { findRequestPage: jest.fn(), findOfferPage: jest.fn() };
    const controller = new TripRequestsController(service), req = { user: { userId: 'authenticated' } };
    await controller.ownPage(req, { limit: 20 }); await controller.availablePage(req, {}); await controller.offersPage(req, {});
    expect(service.findRequestPage).toHaveBeenCalledWith('authenticated', true, { limit: 20 });
    expect(service.findRequestPage).toHaveBeenCalledWith('authenticated', false, {});
    expect(service.findOfferPage).toHaveBeenCalledWith('authenticated', {});
  });
});
