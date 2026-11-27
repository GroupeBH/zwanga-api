import { DriverDispatchService } from './dispatch.service';
import { enqueueSharedTripAlert } from './shared-trip-alert';

jest.mock('./shared-trip-alert', () => ({ enqueueSharedTripAlert: jest.fn().mockResolvedValue(false) }));

describe('dispatch batch isolation', () => {
  it('filters unusable requests before LIMIT and continues after one allocation fails', async () => {
    const requests = Array.from({ length: 7 }, (_, i) => ({ id: String(i), immediateDispatch: true }));
    const query = jest.fn(async (sql: string) => sql.startsWith('WITH candidates') ? requests : []);
    const db = { query, transaction: async (fn: any) => fn({}) };
    const notifications = { dispatchTransactionalNotifications: jest.fn().mockResolvedValue(undefined) };
    const service = new DriverDispatchService(db as any, { get: () => 'true' } as any, notifications as any);
    let inFlight = 0, peak = 0;
    const allocated: string[] = [];
    jest.spyOn(service as any, 'allocate').mockImplementation(async (id: string) => {
      allocated.push(id); inFlight++; peak = Math.max(peak, inFlight);
      await new Promise(resolve => setImmediate(resolve)); inFlight--;
      if (id === '1') throw new Error('synthetic request failure');
    });
    await service.tick();
    expect(new Set(allocated).size).toBe(7); expect(peak).toBe(3);
    const selection = query.mock.calls.find(([sql]) => sql.startsWith('WITH candidates'))![0];
    expect(selection).toContain('r."departurePoint" IS NOT NULL');
    expect(selection).toContain('r."maxPricePerSeat" IS NOT NULL');
    expect(query).toHaveBeenCalledWith(expect.stringContaining('SET "dispatchCheckedAt"'), ['1']);
    expect(query.mock.calls.filter(([sql]) => sql.includes('SET "dispatchLeaseId"=NULL'))).toHaveLength(1);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('FOR UPDATE SKIP LOCKED'),
      [requests.map(r => r.id), expect.any(String)]);
    expect(enqueueSharedTripAlert).toHaveBeenCalledTimes(6);
    expect(notifications.dispatchTransactionalNotifications).toHaveBeenCalledTimes(1);
    expect(service['ticking']).toBe(false);
  });
  it('keeps retrying and dispatching alerts when batch release fails', async () => {
    const query = jest.fn(async (sql: string) => {
      if (sql.startsWith('WITH candidates')) return [{ id: 'request', immediateDispatch: true }];
      if (sql.includes('SET "dispatchLeaseId"=NULL')) throw new Error('synthetic release failure');
      return [];
    });
    const notifications = { dispatchTransactionalNotifications: jest.fn().mockResolvedValue(undefined) };
    const sequential = { poll: jest.fn().mockResolvedValue(false) };
    const service = new DriverDispatchService({ query } as never, { get: () => 'true' } as never,
      notifications as never, undefined, sequential as never);
    await service.tick(); await service.tick();
    expect(sequential.poll).toHaveBeenCalledTimes(2);
    expect(notifications.dispatchTransactionalNotifications).toHaveBeenCalledTimes(2);
    expect(service['ticking']).toBe(false);
  });
});
