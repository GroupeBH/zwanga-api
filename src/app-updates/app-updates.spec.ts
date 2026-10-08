import 'reflect-metadata';
import { validate } from 'class-validator';
import { AppUpdatesService } from './app-updates.service';
import { AppUpdatesController } from './app-updates.controller';
import { PublishAppReleaseDto } from './app-update.dto';
import { normalizeAppVersion } from './app-update.policy';
import { AppUpdateDispatchService, isAppUpdateDeliverable } from './app-update-dispatch.service';
import { RolesGuard, ROLES_KEY } from '../common/guards/roles.guard';
import { UserRole } from '../users/entities/user.entity';
import { Reflector } from '@nestjs/core';

describe('app update policy and boundaries', () => {
  it('normalizes numeric versions and rejects invalid/overflow segments', () => {
    expect(normalizeAppVersion('01.10')).toBe('1.10.0');
    for (const value of ['1-beta', '1.2.3.4', '-1', '2147483648', '']) expect(normalizeAppVersion(value)).toBeNull();
  });
  it('requires explicit store confirmation and limits announcement content', async () => {
    const dto = Object.assign(new PublishAppReleaseDto(), { platform: 'ios', version: '1.2', build: '10', notes: '', storeAvailabilityConfirmed: true });
    expect(await validate(dto)).toHaveLength(0);
    dto.storeAvailabilityConfirmed = false;
    expect((await validate(dto)).map(error => error.property)).toContain('storeAvailabilityConfirmed');
    dto.notes = 'a'.repeat(501);
    expect((await validate(dto)).map(error => error.property)).toContain('notes');
  });
  it('does not access the database before rollout is enabled', async () => {
    const db = { query: jest.fn() }, config = { get: () => 'false' };
    const service = new AppUpdatesService(db as any, config as any);
    expect(await service.latest({ platform: 'ios', version: '1', build: '1' })).toEqual({ enabled: false, release: null });
    await expect(service.list()).rejects.toThrow('pas encore');
    await new AppUpdateDispatchService(db as any, config as any).enqueueUpdates();
    expect(db.query).not.toHaveBeenCalled();
  });
  it('only grants administrative publication/retraction to authorized roles', () => {
    const controller = AppUpdatesController.prototype;
    const guard = new RolesGuard(new Reflector());
    for (const handler of [controller.list, controller.publish, controller.withdraw]) {
      expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual([UserRole.ADMIN]);
      const context = (role: UserRole) => ({ getHandler: () => handler, getClass: () => AppUpdatesController, switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }) }) as any;
      expect(() => guard.canActivate(context(UserRole.PASSENGER))).toThrow();
      expect(guard.canActivate(context(UserRole.ADMIN))).toBe(true);
      expect(guard.canActivate(context(UserRole.SUPER_ADMIN))).toBe(true);
    }
    expect(Reflect.getMetadata('isPublic', controller.register)).not.toBe(true);
    expect(Reflect.getMetadata('isPublic', controller.latest)).toBe(true);
  });
  it('rejects forged identifiers before querying delivery eligibility', async () => {
    const manager = { query: jest.fn() };
    expect(await isAppUpdateDeliverable(manager as any, '../x', 'test')).toBe(false);
    expect(await isAppUpdateDeliverable(manager as any, '1', null)).toBe(false);
    expect(manager.query).not.toHaveBeenCalled();
  });
  it('rejects a token not owned by this authenticated user', async () => {
    const db = { query: jest.fn().mockResolvedValue([{ fcmToken: 'current' }]) };
    const service = new AppUpdatesService(db as any, { get: () => 'true' } as any);
    await expect(service.register('test', { platform: 'ios', version: '1', build: '1', pushToken: 'other' })).rejects.toThrow('en cours');
    expect(db.query).toHaveBeenCalledTimes(1);
  });
});
