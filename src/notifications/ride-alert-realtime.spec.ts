import { RideAlertRealtime } from './ride-alert-realtime.service';
import { RideAlertChanges } from './ride-alert-changes';
import { TripRequest } from '../trip-requests/entities/trip-request.entity';

describe('private ride state hints', () => {
  it('only addresses the server-owned user room and tolerates missing/failed sockets', () => {
    const service = new RideAlertRealtime();
    expect(() => service.publish('u', { kind: 'changed' })).not.toThrow();
    const emit = jest.fn(); const to = jest.fn(() => ({ emit }));
    service.bind({ to } as any);
    service.publish('u', { kind: 'changed', recipientId: 'forged' });
    expect(to).toHaveBeenCalledWith('user:u');
    expect(emit).toHaveBeenCalledWith('ride_alert', { kind: 'changed', recipientId: 'u' });
    to.mockImplementation(() => { throw new Error('offline'); });
    expect(() => service.publish('u', {})).not.toThrow();
  });
  it('never emits before outer commit or after rollback; bounds/cleans its subscriber', async () => {
    const publish = jest.fn();
    const db: any = { subscribers: [], query: jest.fn().mockResolvedValue([{ userId: 'u' }]) };
    const service = new RideAlertChanges(db, { publish } as any);
    const runner = { isTransactionActive: true };
    const event: any = { metadata: { target: TripRequest }, queryRunner: runner,
      entity: { id: 'request', status: 'cancelled' }, databaseEntity: { status: 'pending' } };
    await service.afterUpdate(event);
    await service.afterTransactionCommit({ queryRunner: runner } as any);
    expect(publish).not.toHaveBeenCalled();
    service.afterTransactionRollback({ queryRunner: runner } as any);
    runner.isTransactionActive = false;
    await service.afterTransactionCommit({ queryRunner: runner } as any);
    expect(publish).not.toHaveBeenCalled();
    runner.isTransactionActive = true;
    await service.afterUpdate(event); runner.isTransactionActive = false;
    await service.afterTransactionCommit({ queryRunner: runner } as any);
    await new Promise(resolve => setImmediate(resolve));
    expect(publish).toHaveBeenCalledWith('u', { kind: 'changed', requestId: 'request', terminal: true });
    service.onModuleDestroy(); expect(db.subscribers).toHaveLength(0);
  });
  it('releases commit without awaiting another pool connection and bounds/coalesces queued hints', async () => {
    let release!: (value: unknown[]) => void;
    const db: any = { subscribers: [], query: jest.fn(() => new Promise(resolve => { release = resolve; })) };
    const publish = jest.fn();
    const service = new RideAlertChanges(db, { publish } as any);
    const runner = { isTransactionActive: true };
    await service.afterUpdate({ metadata: { target: TripRequest }, queryRunner: runner,
      entity: { id: 'first', status: 'cancelled' }, databaseEntity: { status: 'pending' } } as any);
    runner.isTransactionActive = false;
    await service.afterTransactionCommit({ queryRunner: runner } as any);
    expect(db.query).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 1000; i++) service.enqueue({ kind: 'request', id: String(i), terminal: true });
    expect((service as any).ready.size).toBe(200);
    expect(db.query).toHaveBeenCalledTimes(1);
    service.onModuleDestroy(); release([{ userId: 'u' }]);
    await new Promise(resolve => setImmediate(resolve));
    expect(publish).not.toHaveBeenCalled(); expect((service as any).ready.size).toBe(0);
  });
});
