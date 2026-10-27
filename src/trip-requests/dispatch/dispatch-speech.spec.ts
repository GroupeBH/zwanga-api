import { DriverDispatchService } from './dispatch.service';
import {
  enqueueTransactionalNotification,
  enqueueTransactionalNotifications,
  TransactionalNotification,
} from '../../notifications/transactional-notification';

jest.mock('../../notifications/transactional-notification', () => ({
  enqueueTransactionalNotification: jest.fn(),
  enqueueTransactionalNotifications: jest.fn(),
}));

describe('dispatch speech descriptions', () => {
  beforeEach(() => jest.clearAllMocks());
  afterEach(() => jest.restoreAllMocks());

  it.each([1, 3, 50])('describes all %i invitations without extra ride queries per driver', async (count) => {
    const now = Date.parse('2026-10-21T09:00:00Z');
    jest.spyOn(Date, 'now').mockReturnValue(now);
    const request = {
      id: 'request', passengerId: 'passenger', immediateDispatch: true, status: 'pending',
      departurePoint: { coordinates: [15, -4] }, vehicleType: 'car',
      departureLocation: 'Place centrale', arrivalLocation: 'Gare', numberOfSeats: 2, maxPricePerSeat: 2000,
      departureDateMin: new Date(now), departureDateMax: new Date(now + 60000),
    };
    const builder = {
      where: jest.fn().mockReturnThis(), andWhere: jest.fn().mockReturnThis(),
      setLock: jest.fn().mockReturnThis(), setOnLocked: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(request),
    };
    const candidates = Array.from({ length: count }, (_, index) => ({
      driverId: `driver-${index}`, vehicleId: `vehicle-${index}`, seats: 4, brand: 'Test', model: 'Car',
    }));
    const query = jest.fn(async (sql: string, _parameters: unknown[]) =>
      sql.startsWith('WITH candidates AS MATERIALIZED') ? candidates : [],
    );
    const manager = { getRepository: () => ({ createQueryBuilder: () => builder, update: jest.fn() }), query };
    const service = new DriverDispatchService({ transaction: (work: any) => work(manager) } as any,
      { get: () => undefined } as any, {} as any);

    await (service as any).allocate(request.id);

    expect(query).toHaveBeenCalledTimes(5);
    const selection = query.mock.calls.find(([sql]) => sql.startsWith('WITH candidates'))!;
    expect(selection[0]).toContain('p."driverId" <> $1::uuid');
    expect(selection[0]).toContain('LIMIT 50 FOR UPDATE OF locked SKIP LOCKED');
    expect(selection[0]).toContain('locked.xmin = c."presenceVersion"');
    expect(selection[1][0]).toBe('passenger');
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('"driverId" = ANY($1::uuid[])'),
      [candidates.map(candidate => candidate.driverId)],
    );
    expect(enqueueTransactionalNotification).not.toHaveBeenCalled();
    expect(enqueueTransactionalNotifications).toHaveBeenCalledTimes(1);
    const [outboxManager, notifications] = (enqueueTransactionalNotifications as jest.Mock).mock.calls[0] as [unknown, TransactionalNotification[]];
    expect(outboxManager).toBe(manager);
    expect(notifications).toHaveLength(count);
    expect(new Set(notifications.map(notification => notification.eventKey)).size).toBe(count);
    notifications.forEach((notification, index) => {
      expect(notification.userId).toBe(candidates[index].driverId);
      expect(notification.eventKey).toBe(`dispatch-offer:${notification.data.offerId}`);
      expect(notification.data).toMatchObject({
        type: 'driver_dispatch_offer', tripRequestId: 'request', passengerId: 'passenger',
        rideSpeechVersion: '1', rideDeparture: 'Place centrale', rideArrival: 'Gare', rideSeats: '2',
        rideDepartureAt: '2026-10-21T09:00:00.000Z', ridePricePerSeat: '2000', ridePriceKind: 'budget',
      });
    });
  });
});
