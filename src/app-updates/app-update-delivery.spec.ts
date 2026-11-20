import { AppUpdateDeliveryService } from './app-update-delivery.service';
import { AppUpdateDispatchService } from './app-update-dispatch.service';
import { InstallationUpdateDispatchService } from './installation-update-dispatch.service';
import { AppUpdatesService } from './app-updates.service';
import { AppUpdatesController } from './app-updates.controller';
import { StoreService } from '../store-management/store.service';
import { StoreConfig } from '../store-management/store.config';
import { ConfigService } from '@nestjs/config';
import { ROLES_KEY } from '../common/guards/roles.guard';
import { UserRole } from '../users/entities/user.entity';

describe('Update preparation triggered from administration', () => {
  const config = { get: () => 'true' };
  it('queues both audiences immediately and reports partial failures honestly', async () => {
    const accounts = { enqueueUpdates: jest.fn().mockResolvedValue({ state: 'prepared', queued: 2 }) };
    const installations = { enqueue: jest.fn().mockResolvedValue({ state: 'retry_pending', queued: 1 }) };
    const service = new AppUpdateDeliveryService(accounts as any, installations as any);
    expect(await service.prepare('12')).toEqual({ state: 'retry_pending', queued: 3 });
    expect(accounts.enqueueUpdates).toHaveBeenCalledWith('12');
    expect(installations.enqueue).toHaveBeenCalledWith('12');
  });
  it('prepares notifications only after publication commits', async () => {
    const events: string[] = [];
    const release = { id: '12', available: true, platform: 'android', version: '2.0.0', build: '20.0.0' };
    const manager = { query: jest.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([release]) };
    const db = { transaction: jest.fn(async work => { const result = await work(manager); events.push('committed'); return result; }) };
    const delivery = { prepare: jest.fn(async () => { events.push('prepared'); return { state: 'prepared', queued: 1 }; }) };
    const service = new AppUpdatesService(db as any, config as any, delivery as any);
    await expect(service.publish('admin', { platform: 'android', version: '2', build: '20', notes: '', storeAvailabilityConfirmed: true })).resolves.toMatchObject({ id: '12', dispatch: { queued: 1 } });
    expect(events).toEqual(['committed', 'prepared']);
  });
  it('never queues after a failed transaction or a withdrawn release', async () => {
    const delivery = { prepare: jest.fn() };
    const input = { platform: 'android' as const, version: '2', build: '20', notes: '', storeAvailabilityConfirmed: true };
    const failing = new AppUpdatesService({ transaction: () => Promise.reject(new Error('DB unavailable')) } as any, config as any, delivery as any);
    await expect(failing.publish('admin', input)).rejects.toThrow('DB unavailable');
    const withdrawn = new AppUpdatesService({ transaction: async () => ({ id: '12', available: false }) } as any, config as any, delivery as any);
    await expect(withdrawn.publish('admin', input)).resolves.toMatchObject({ available: false });
    expect(delivery.prepare).not.toHaveBeenCalled();
  });
  it('exposes disabled status without accessing data and protects the trigger', async () => {
    const db = { query: jest.fn() };
    const service = new AppUpdatesService(db as any, { get: () => 'false' } as any);
    expect(service.status()).toEqual({ enabled: false, automaticFromStores: false });
    await expect(service.dispatch('12')).rejects.toThrow();
    expect(db.query).not.toHaveBeenCalled();
    for (const method of ['status', 'dispatch'] as const)
      expect(Reflect.getMetadata(ROLES_KEY, AppUpdatesController.prototype[method])).toEqual([UserRole.ADMIN]);
    const controller = new AppUpdatesController({ dispatch: jest.fn() } as any);
    expect(() => controller.dispatch('../12')).toThrow();
  });
  it('counts new outbox rows, scopes manual triggers and keeps retry state on failure', async () => {
    const db = { query: jest.fn().mockResolvedValue([{ id: '1' }, { id: '2' }]) };
    const accounts = new AppUpdateDispatchService(db as any, config as any);
    expect(await accounts.enqueueUpdates('12')).toEqual({ state: 'prepared', queued: 2 });
    expect(db.query.mock.calls[0][1]).toEqual(['12']);
    db.query.mockResolvedValueOnce([{ id: '3' }]).mockRejectedValueOnce(new Error('unavailable'));
    expect(await new InstallationUpdateDispatchService(db as any, config as any).enqueue('12')).toEqual({ state: 'retry_pending', queued: 1 });
  });
  it('does not enqueue an impossible Google catalogue import', async () => {
    const repository = { enqueue: jest.fn() };
    const config = new StoreConfig(new ConfigService({ STORE_MANAGEMENT_ENABLED: 'true', STORE_GOOGLE_PACKAGE_NAME: 'com.example.test', STORE_GOOGLE_CLIENT_EMAIL: 'test@example.invalid', STORE_GOOGLE_PRIVATE_KEY: 'fake-test-key' }));
    const service = new StoreService(config, repository as any, {} as any);
    await expect(service.sync('admin', 'google', { task: 'catalog', requestId: 'id', from: '2026-11-01', to: '2026-11-10' } as any)).rejects.toMatchObject({ response: { code: 'GOOGLE_CATALOG_TEMPORARY_EDIT_NOT_ALLOWED' } });
    expect(repository.enqueue).not.toHaveBeenCalled();
  });
});
