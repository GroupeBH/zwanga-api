import { DriverAvailabilityChanges } from './driver-availability-changes';
import { TripRequest } from '../entities/trip-request.entity';
import { Trip } from '../../trips/entities/trip.entity';

describe('availability changes after commit only', () => {
  const flush = () => new Promise(resolve => setImmediate(resolve));
  const setup = () => {
    const db = { subscribers: [] as any[], query: jest.fn().mockResolvedValue([{ driverId: 'driver' }]) };
    const wakeups = { requestReleased: jest.fn().mockResolvedValue(true), driversAvailable: jest.fn().mockResolvedValue(true) };
    const subscriber = new DriverAvailabilityChanges(db as any, { get: () => 'true' } as any, wakeups as any);
    const runner = { isTransactionActive: true };
    const event = { metadata: { target: TripRequest }, entity: { id: 'r', status: 'cancelled' },
      databaseEntity: { status: 'pending' }, queryRunner: runner };
    return { db, wakeups, subscriber, runner, event };
  };
  it('coalesces events, waits for outer commit and never holds the origin connection while querying', async () => {
    const f = setup(); f.subscriber.afterUpdate(f.event as any); f.subscriber.afterUpdate(f.event as any);
    f.subscriber.afterTransactionCommit({ queryRunner: f.runner } as any);
    await flush(); expect(f.wakeups.requestReleased).not.toHaveBeenCalled();
    f.runner.isTransactionActive = false;
    f.subscriber.afterTransactionCommit({ queryRunner: f.runner } as any);
    expect(f.wakeups.requestReleased).not.toHaveBeenCalled();
    await flush(); expect(f.wakeups.requestReleased).toHaveBeenCalledTimes(1);
  });
  it('drops hints on rollback, including a rolled-back savepoint', async () => {
    const f = setup(); f.subscriber.afterUpdate(f.event as any);
    f.subscriber.afterTransactionRollback({ queryRunner: f.runner } as any);
    f.runner.isTransactionActive = false; f.subscriber.afterTransactionCommit({ queryRunner: f.runner } as any);
    await flush(); expect(f.wakeups.requestReleased).not.toHaveBeenCalled();
  });
  it('wakes a completed trip driver, not every ongoing GPS write', async () => {
    const f = setup(); f.runner.isTransactionActive = false;
    f.subscriber.afterUpdate({ ...f.event, metadata: { target: Trip }, entity: { id: 't', status: 'ongoing' } } as any);
    await flush(); expect(f.db.query).not.toHaveBeenCalled();
    f.subscriber.afterUpdate({ ...f.event, metadata: { target: Trip }, entity: { id: 't', status: 'completed' } } as any);
    await flush(); expect(f.wakeups.driversAvailable).toHaveBeenCalledWith(['driver']);
    f.subscriber.onModuleDestroy(); expect(f.db.subscribers).toEqual([]);
  });
});
