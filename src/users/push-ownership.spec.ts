import { UsersService } from './users.service';
import { AuthService } from '../auth/auth.service';

describe('push token account ownership', () => {
  it('rejects malformed or oversized push identifiers before acquiring a database lock', async () => {
    const service = Object.create(UsersService.prototype);
    for (const token of [null, {}, '', 'bad token', 'x'.repeat(1025)]) {
      await expect(service.updateFcmToken('a', token)).rejects.toThrow('notification invalide');
    }
  });
  it('detaches former owners even when the current account already holds the same device token', async () => {
    const order: string[] = [];
    const query = { update: jest.fn().mockReturnThis(), set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(), execute: jest.fn(async () => { order.push('detach'); }) };
    const repo = { findOne: jest.fn(async () => ({ id: 'b', fcmToken: 'device' })),
      createQueryBuilder: jest.fn(() => query), update: jest.fn(async () => { order.push('attach'); }) };
    const manager = { query: jest.fn(async (sql: string) => { order.push(sql.startsWith('SELECT') ? 'lock' : 'clear-capability'); }), getRepository: () => repo };
    const service = Object.create(UsersService.prototype);
    service.logger = { debug() {} };
    service.userRepository = { manager: { transaction: async (fn: any) => fn(manager) } };
    await service.updateFcmToken('b', 'device');
    expect(order).toEqual(['lock', 'clear-capability', 'clear-capability', 'detach', 'attach']);
    expect(query.where).toHaveBeenCalledWith('"fcmToken" = :fcmToken AND id <> :userId', { fcmToken: 'device', userId: 'b' });
    expect(query.set).toHaveBeenCalledWith({ fcmToken: null });
    expect(repo.update).toHaveBeenCalledWith('b', { fcmToken: 'device' });
  });

  it('server logout revokes push together with access and refresh credentials', async () => {
    const service = Object.create(AuthService.prototype);
    service.logger = { log() {} };
    service.userRepository = { findOne: jest.fn().mockResolvedValue({ id: 'a' }), update: jest.fn() };
    await service.logout('a');
    expect(service.userRepository.update).toHaveBeenCalledWith('a', { accessToken: null, refreshToken: null, fcmToken: null });
  });
});
