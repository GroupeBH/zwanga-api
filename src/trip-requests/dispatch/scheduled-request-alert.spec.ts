import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { EntityManager } from 'typeorm';
import { TripRequest, TripRequestStatus } from '../entities/trip-request.entity';
import { assertDriverCanOperate } from '../../users/driver-activation';
import { enqueueTransactionalNotification } from '../../notifications/transactional-notification';
import { enqueueScheduledRequestAlert } from './scheduled-request-alert';

jest.mock('../../users/driver-activation', () => ({ assertDriverCanOperate: jest.fn() }));
jest.mock('../../notifications/transactional-notification', () => ({ enqueueTransactionalNotification: jest.fn() }));

describe('scheduled nearby request alert', () => {
  const fixture = () => {
    const request = { id: 'request', passengerId: 'passenger', immediateDispatch: false,
      status: TripRequestStatus.PENDING, selectedDriverId: null, tripId: null,
      departurePoint: { type: 'Point', coordinates: [15.3, -4.3] }, vehicleType: 'car', numberOfSeats: 2,
      departureLocation: 'Départ', arrivalLocation: 'Arrivée',
      departureDateMin: new Date(Date.now() + 86_400_000), departureDateMax: new Date(Date.now() + 90_000_000) };
    const query = jest.fn().mockImplementation(async (sql: string) => sql.includes('driver_notification_clients')
      ? [{}] : [{ driverId: 'nearest' }, { driverId: 'next' }]);
    const drivers = jest.fn().mockImplementation(async ({ id }: { id: string }) => ({ id, fcmToken: `test-${id}` }));
    const findRequest = jest.fn().mockResolvedValue(request);
    const manager = { query, getRepository: (entity: unknown) => entity === TripRequest
      ? { findOne: findRequest } : { findOneBy: drivers } } as unknown as EntityManager;
    const busy = jest.fn().mockResolvedValue(false);
    return { request, query, drivers, findRequest, manager, busy,
      run: () => enqueueScheduledRequestAlert(manager, request.id, 5000, busy) };
  };
  beforeEach(() => jest.resetAllMocks());

  it('queues one deduplicated alert for the nearest eligible driver without assigning the future trip', async () => {
    const f = fixture(); const before = structuredClone(f.request);
    await expect(f.run()).resolves.toBe(true);
    const [sql, parameters] = f.query.mock.calls[0];
    expect(sql).toContain('ST_DWithin'); expect(sql).toContain('ORDER BY ST_Distance');
    expect(sql).toContain('LIMIT 20'); expect(sql).toContain('v."isActive" = true');
    expect(sql).toContain('v.type = $5'); expect(sql).toContain('>= $6');
    expect(sql).toContain('p."expiresAt" > now()'); expect(sql).toContain('NOT EXISTS');
    expect(parameters).toEqual(['passenger', 15.3, -4.3, 5000, 'car', 2]);
    expect(f.findRequest).toHaveBeenCalledWith({ where: { id: 'request' }, lock: { mode: 'pessimistic_read' } });
    expect(assertDriverCanOperate).toHaveBeenCalledWith(f.manager, { id: 'nearest', fcmToken: 'test-nearest' });
    expect(f.query.mock.calls[1][1]).toEqual(['nearest', createHash('sha256').update('test-nearest:driver-v2').digest('hex')]);
    expect(enqueueTransactionalNotification).toHaveBeenCalledTimes(1);
    expect(enqueueTransactionalNotification).toHaveBeenCalledWith(f.manager, expect.objectContaining({
      eventKey: 'nearby-scheduled-request:request', userId: 'nearest', title: 'Commande programmée à proximité',
      data: expect.objectContaining({ type: 'trip_request_nearby', ringAlert: 'nearby-request-v1',
        tripRequestId: 'request', driverId: 'nearest', role: 'driver' }),
    }));
    expect(f.request).toEqual(before); expect(f.drivers).toHaveBeenCalledTimes(1);
  });

  it.each(['busy', 'no-token', 'identity', 'forbidden', 'old-client'])('skips the nearest if %s and tries the next eligible driver', async reason => {
    const f = fixture();
    if (reason === 'busy') f.busy.mockResolvedValueOnce(true);
    if (reason === 'no-token') f.drivers.mockResolvedValueOnce({ id: 'nearest', fcmToken: null });
    if (reason === 'identity') (assertDriverCanOperate as jest.Mock).mockRejectedValueOnce(new BadRequestException());
    if (reason === 'forbidden') (assertDriverCanOperate as jest.Mock).mockRejectedValueOnce(new ForbiddenException());
    if (reason === 'old-client') f.query.mockResolvedValueOnce([{ driverId: 'nearest' }, { driverId: 'next' }]).mockResolvedValueOnce([]);
    await expect(f.run()).resolves.toBe(true);
    expect(enqueueTransactionalNotification).toHaveBeenCalledTimes(1);
    expect(enqueueTransactionalNotification).toHaveBeenCalledWith(f.manager, expect.objectContaining({ userId: 'next' }));
  });

  it.each([{ immediateDispatch: true }, { status: TripRequestStatus.DRIVER_SELECTED }, { selectedDriverId: 'driver' },
    { tripId: 'trip' }, { departurePoint: null }, { departureDateMax: new Date(0) }])('ignores unavailable request %j', async patch => {
    const f = fixture(); Object.assign(f.request, patch);
    await expect(f.run()).resolves.toBe(false);
    expect(f.query).not.toHaveBeenCalled(); expect(enqueueTransactionalNotification).not.toHaveBeenCalled();
  });
  it('does not broadcast if no eligible driver has a recent compatible position', async () => {
    const f = fixture(); f.query.mockResolvedValue([]);
    await expect(f.run()).resolves.toBe(false);
    expect(enqueueTransactionalNotification).not.toHaveBeenCalled();
  });
  it('returns false for legacy-only clients so creation can use the compatible notification', async () => {
    const f = fixture();
    f.query.mockImplementation(async (sql: string) => sql.includes('driver_notification_clients')
      ? [] : [{ driverId: 'nearest' }, { driverId: 'next' }]);
    await expect(f.run()).resolves.toBe(false);
    expect(f.drivers).toHaveBeenCalledTimes(2);
    expect(enqueueTransactionalNotification).not.toHaveBeenCalled();
  });
  it('propagates database errors so the caller can roll back the outbox transaction', async () => {
    const f = fixture(); (assertDriverCanOperate as jest.Mock).mockRejectedValue(new Error('database unavailable'));
    await expect(f.run()).rejects.toThrow('database unavailable');
    expect(enqueueTransactionalNotification).not.toHaveBeenCalled();
  });
});
