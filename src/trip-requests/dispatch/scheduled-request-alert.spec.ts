import type { EntityManager } from 'typeorm';
import { TripRequest, TripRequestStatus } from '../entities/trip-request.entity';
import { enqueueTransactionalNotifications } from '../../notifications/transactional-notification';
import { enqueueScheduledRequestAlert } from './scheduled-request-alert';

jest.mock('../../notifications/transactional-notification', () => ({ enqueueTransactionalNotifications: jest.fn() }));

describe('scheduled nearby request alert', () => {
  const fixture = () => {
    const request = { id: 'request', passengerId: 'passenger', immediateDispatch: false,
      status: TripRequestStatus.PENDING, selectedDriverId: null, tripId: null,
      departurePoint: { type: 'Point', coordinates: [15.3, -4.3] }, vehicleType: 'car', numberOfSeats: 2,
      departureLocation: 'Départ', arrivalLocation: 'Arrivée', maxPricePerSeat: 2500,
      departureDateMin: new Date(Date.now() + 86_400_000), departureDateMax: new Date(Date.now() + 90_000_000) };
    const query = jest.fn().mockImplementation(async (sql: string) => sql.includes('FROM driver_dispatch_presence')
      ? [{ driverId: 'nearest' }, { driverId: 'next' }] : [{}]);
    const drivers = jest.fn().mockImplementation(async ({ id }: { id: string }) => ({ id, fcmToken: `test-${id}` }));
    const findRequest = jest.fn().mockResolvedValue(request);
    const manager = { query, getRepository: (entity: unknown) => entity === TripRequest
      ? { findOne: findRequest, update: jest.fn().mockResolvedValue({}) } : { findOneBy: drivers } } as unknown as EntityManager;
    const busy = jest.fn().mockResolvedValue(false);
    return { request, query, drivers, findRequest, manager, busy,
      run: () => enqueueScheduledRequestAlert(manager, request.id, 5000, busy) };
  };
  beforeEach(() => jest.resetAllMocks());

  it('queues a deduplicated alert for every eligible nearby driver without assigning the future trip', async () => {
    const f = fixture(); const before = structuredClone(f.request);
    await expect(f.run()).resolves.toBe(true);
    const [sql, parameters] = f.query.mock.calls[0];
    expect(sql).toContain('ST_DWithin'); expect(sql).toContain('ORDER BY ST_Distance');
    expect(sql).toContain('p."driverId" <> $1::uuid');
    expect(sql).toContain('LIMIT 50'); expect(sql).toContain('v."isActive" = true');
    expect(sql).toContain('v.type = $5'); expect(sql).toContain('>= $6');
    expect(sql).toContain('p."discoveryEnabled" = true');
    expect(sql).toContain('p."discoveryEnabled" IS NULL AND p."expiresAt" > now()'); expect(sql).toContain('NOT EXISTS');
    expect(parameters).toEqual(['passenger', 15.3, -4.3, 5000, 'car', 2, 'request']);
    expect(f.findRequest).toHaveBeenCalledWith({ where: { id: 'request' }, lock: { mode: 'pessimistic_write', onLocked: 'skip_locked' } });
    expect(f.query).toHaveBeenCalledTimes(1);
    expect(enqueueTransactionalNotifications).toHaveBeenCalledTimes(1);
    expect(enqueueTransactionalNotifications).toHaveBeenCalledWith(f.manager, [expect.objectContaining({
      eventKey: 'nearby-scheduled-request:request:nearest', userId: 'nearest', title: 'Commande programmée à proximité',
      data: expect.objectContaining({ type: 'trip_request_nearby', ringAlert: 'nearby-request-v1',
        rideSpeechVersion: '1', rideDeparture: 'Départ', rideArrival: 'Arrivée', rideSeats: '2',
        rideDepartureAt: f.request.departureDateMin.toISOString(), ridePricePerSeat: '2500', ridePriceKind: 'budget',
        tripRequestId: 'request', passengerId: 'passenger', driverId: 'nearest', role: 'driver' }),
    }), expect.objectContaining({
      eventKey: 'nearby-scheduled-request:request:next', userId: 'next',
    })]);
    expect(f.request).toEqual(before); expect(f.drivers).not.toHaveBeenCalled();
  });

  it.each(['FROM trips', 'u."fcmToken" IS NOT NULL', 'kyc_documents', "u.status NOT IN ('suspended', 'inactive')"])('filters %s before the bounded selection', async predicate => {
    const f = fixture();
    f.query.mockResolvedValueOnce([{ driverId: 'next' }]);
    await expect(f.run()).resolves.toBe(true);
    expect(f.query.mock.calls[0][0]).toContain(predicate);
    expect(enqueueTransactionalNotifications).toHaveBeenCalledWith(f.manager, [expect.objectContaining({ userId: 'next' })]);
  });

  it.each([{ immediateDispatch: true }, { status: TripRequestStatus.DRIVER_SELECTED }, { selectedDriverId: 'driver' },
    { tripId: 'trip' }, { departurePoint: null }, { departureDateMax: new Date(0) }])('ignores unavailable request %j', async patch => {
    const f = fixture(); Object.assign(f.request, patch);
    await expect(f.run()).resolves.toBe(false);
    expect(f.query).not.toHaveBeenCalled(); expect(enqueueTransactionalNotifications).not.toHaveBeenCalled();
  });
  it('does not broadcast if no eligible driver has a compatible known position', async () => {
    const f = fixture(); f.query.mockResolvedValue([]);
    await expect(f.run()).resolves.toBe(false);
    expect(enqueueTransactionalNotifications).not.toHaveBeenCalled();
  });
  it('queues all eligible nearby recipients even when sound capability registration is absent', async () => {
    const f = fixture();
    await expect(f.run()).resolves.toBe(true);
    const sql = f.query.mock.calls[0][0];
    expect(sql).not.toContain('driver_notification_clients');
    expect(f.drivers).not.toHaveBeenCalled();
    expect(enqueueTransactionalNotifications).toHaveBeenCalledWith(f.manager, [
      expect.objectContaining({ userId: 'nearest' }), expect.objectContaining({ userId: 'next' }),
    ]);
  });
  it('propagates database errors so the caller can roll back the outbox transaction', async () => {
    const f = fixture(); f.query.mockRejectedValue(new Error('database unavailable'));
    await expect(f.run()).rejects.toThrow('database unavailable');
    expect(enqueueTransactionalNotifications).not.toHaveBeenCalled();
  });
});
