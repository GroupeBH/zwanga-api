import { DriverDispatchService } from './dispatch.service';
import { enqueueTransactionalNotification } from '../../notifications/transactional-notification';

jest.mock('../../notifications/transactional-notification', () => ({ enqueueTransactionalNotification: jest.fn() }));

it('adds a structured description to the next immediate offer without querying more ride data', async () => {
  const request = { id: 'request', passengerId: 'passenger', immediateDispatch: true, status: 'pending', departurePoint: { coordinates: [15, -4] },
    departureLocation: 'Place centrale', arrivalLocation: 'Gare', numberOfSeats: 2, maxPricePerSeat: 2000,
    departureDateMin: new Date('2026-10-21T09:00:00Z'), departureDateMax: new Date(Date.now() + 60000) };
  const builder = { where: jest.fn().mockReturnThis(), andWhere: jest.fn().mockReturnThis(),
    setLock: jest.fn().mockReturnThis(), setOnLocked: jest.fn().mockReturnThis(), getOne: jest.fn().mockResolvedValue(request) };
  const query = jest.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([])
    .mockResolvedValueOnce([{ driverId: 'first', vehicleId: 'vehicle1', seats: 4 }]).mockResolvedValue([]);
  const manager = { getRepository: () => ({ createQueryBuilder: () => builder, update: jest.fn() }), query };
  const service = new DriverDispatchService({ transaction: (work: any) => work(manager) } as any,
    { get: () => undefined } as any, {} as any);
  await (service as any).allocate(request.id);
  expect(query).toHaveBeenCalledTimes(5);
  expect(query.mock.calls[2][0]).toContain('p."driverId" <> $1::uuid');
  expect(query.mock.calls[2][0]).toContain('LIMIT 1 FOR UPDATE OF p SKIP LOCKED');
  expect(query.mock.calls[2][1][0]).toBe('passenger');
  expect(enqueueTransactionalNotification).toHaveBeenCalledTimes(1);
  const notification = (enqueueTransactionalNotification as jest.Mock).mock.calls[0][1];
  expect(notification.data).toMatchObject({
    type: 'driver_dispatch_offer', tripRequestId: 'request', passengerId: 'passenger', rideSpeechVersion: '1', rideDeparture: 'Place centrale',
    rideArrival: 'Gare', rideSeats: '2', rideDepartureAt: '2026-10-21T09:00:00.000Z',
    ridePricePerSeat: '2000', ridePriceKind: 'budget',
  });
});
