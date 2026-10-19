import { DriverDispatchService } from './dispatch.service';
import { enqueueTransactionalNotifications } from '../../notifications/transactional-notification';

jest.mock('../../notifications/transactional-notification', () => ({ enqueueTransactionalNotifications: jest.fn() }));

it('adds the same structured description to each immediate offer without querying more ride data', async () => {
  const request = { id: 'request', passengerId: 'passenger', departurePoint: { coordinates: [15, -4] },
    departureLocation: 'Place centrale', arrivalLocation: 'Gare', numberOfSeats: 2, maxPricePerSeat: 2000,
    departureDateMin: new Date('2026-10-21T09:00:00Z'), departureDateMax: new Date(Date.now() + 60000) };
  const builder = { where: jest.fn().mockReturnThis(), andWhere: jest.fn().mockReturnThis(),
    setLock: jest.fn().mockReturnThis(), setOnLocked: jest.fn().mockReturnThis(), getOne: jest.fn().mockResolvedValue(request) };
  const query = jest.fn().mockResolvedValueOnce([{ driverId: 'first', vehicleId: 'vehicle1', seats: 4 },
    { driverId: 'second', vehicleId: 'vehicle2', seats: 4 }]).mockResolvedValue([]);
  const manager = { getRepository: () => ({ createQueryBuilder: () => builder, update: jest.fn() }), query };
  const service = new DriverDispatchService({ transaction: (work: any) => work(manager) } as any,
    { get: () => undefined } as any, {} as any);
  await (service as any).allocate(request.id);
  expect(query).toHaveBeenCalledTimes(3);
  const notifications = (enqueueTransactionalNotifications as jest.Mock).mock.calls[0][1];
  expect(notifications).toHaveLength(2);
  for (const notification of notifications) expect(notification.data).toMatchObject({
    type: 'driver_dispatch_offer', tripRequestId: 'request', rideSpeechVersion: '1', rideDeparture: 'Place centrale',
    rideArrival: 'Gare', rideSeats: '2', rideDepartureAt: '2026-10-21T09:00:00.000Z',
  });
});
