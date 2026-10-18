import { ConfigService } from '@nestjs/config';
import type { DataSource, EntityManager } from 'typeorm';
import { NotificationService } from '../../notifications/notifications.service';
import { DriverDispatchService } from './dispatch.service';
import { enqueueScheduledRequestAlert } from './scheduled-request-alert';

jest.mock('./scheduled-request-alert', () => ({ enqueueScheduledRequestAlert: jest.fn() }));

describe('Scheduled request enqueue acknowledgement', () => {
  const enqueue = jest.mocked(enqueueScheduledRequestAlert);
  const fixture = (enabled = true) => {
    const manager = {} as EntityManager;
    const db = { transaction: jest.fn(async (run: (manager: EntityManager) => Promise<boolean>) => run(manager)) };
    const config = { get: jest.fn((key: string) => key === 'DRIVER_DISPATCH_ENABLED' ? String(enabled) : undefined) };
    const notifications = { dispatchTransactionalNotifications: jest.fn().mockResolvedValue(undefined) };
    const service = new DriverDispatchService(
      db as unknown as DataSource, config as unknown as ConfigService,
      notifications as unknown as NotificationService,
    );
    const warn = jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
    return { service, db, manager, notifications, warn };
  };

  beforeEach(() => { jest.resetAllMocks(); enqueue.mockResolvedValue(true); });
  afterEach(() => jest.restoreAllMocks());

  it('returns false without touching the queue when dispatch is disabled', async () => {
    const f = fixture(false);
    await expect(f.service.notifyScheduledRequest('request')).resolves.toBe(false);
    expect(f.db.transaction).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(f.notifications.dispatchTransactionalNotifications).not.toHaveBeenCalled();
  });

  it('returns false when no nearby alert was queued; later ticks may find new drivers', async () => {
    const f = fixture(); enqueue.mockResolvedValue(false);
    await expect(f.service.notifyScheduledRequest('request')).resolves.toBe(false);
    expect(enqueue).toHaveBeenCalledWith(f.manager, 'request', 5000, expect.any(Function));
    expect(f.notifications.dispatchTransactionalNotifications).not.toHaveBeenCalled();
  });

  it('acknowledges the queued alert and only starts push delivery after commit', async () => {
    const f = fixture();
    f.db.transaction.mockImplementation(async run => {
      const queued = await run(f.manager);
      expect(f.notifications.dispatchTransactionalNotifications).not.toHaveBeenCalled();
      return queued;
    });
    await expect(f.service.notifyScheduledRequest('request')).resolves.toBe(true);
    expect(f.notifications.dispatchTransactionalNotifications).toHaveBeenCalledTimes(1);
  });

  it('still returns true when push delivery fails after enqueue, preventing duplicate fallback', async () => {
    const f = fixture();
    f.notifications.dispatchTransactionalNotifications.mockRejectedValue(new Error('push provider unavailable'));
    await expect(f.service.notifyScheduledRequest('request')).resolves.toBe(true);
    expect(f.warn).toHaveBeenCalledWith('Nearby request push delivery deferred.');
  });

  it('propagates enqueue failures so creation can defer to the next dispatch tick', async () => {
    const f = fixture(); enqueue.mockRejectedValue(new Error('queue unavailable'));
    await expect(f.service.notifyScheduledRequest('request')).rejects.toThrow('queue unavailable');
    expect(f.notifications.dispatchTransactionalNotifications).not.toHaveBeenCalled();
  });

  it('does not acknowledge or deliver an alert if the transaction fails to commit', async () => {
    const f = fixture();
    f.db.transaction.mockImplementation(async run => {
      await run(f.manager);
      throw new Error('commit failed');
    });
    await expect(f.service.notifyScheduledRequest('request')).rejects.toThrow('commit failed');
    expect(f.notifications.dispatchTransactionalNotifications).not.toHaveBeenCalled();
  });
});
