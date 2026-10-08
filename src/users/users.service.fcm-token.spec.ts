import { UsersService } from './users.service';
import { EntityManager } from 'typeorm';

describe('UsersService.updateFcmToken', () => {
  function fixture(user: { id: string; fcmToken: string }) {
    const update = jest.fn().mockResolvedValue({ affected: 1 });
    const detach = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 0 }),
    };
    const repository = {
      update,
      findOne: jest.fn().mockResolvedValue(user),
      createQueryBuilder: () => detach,
    };
    const query = jest.fn().mockResolvedValue([]);
    const transaction = jest.fn(
      (work: (manager: EntityManager) => Promise<void>) =>
        work({
          query,
          getRepository: () => repository,
        } as unknown as EntityManager),
    );
    const service = {
      logger: { debug: jest.fn() },
      userRepository: { manager: { transaction } },
    } as unknown as UsersService;
    return { service, update, transaction, detach, query };
  }

  it('reasserts exclusive device ownership even when the token is already current', async () => {
    const user = { id: 'user-1', fcmToken: 'same-token' };
    const { service, update, transaction, detach, query } = fixture(user);

    await UsersService.prototype.updateFcmToken.call(
      service,
      user.id,
      user.fcmToken,
    );

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenNthCalledWith(
      1,
      'SELECT pg_advisory_xact_lock(782341, 1)',
    );
    expect(detach.set).toHaveBeenCalledWith({ fcmToken: null });
    expect(detach.where).toHaveBeenCalledWith(
      '"fcmToken" = :fcmToken AND id <> :userId',
      { fcmToken: user.fcmToken, userId: user.id },
    );
    expect(update).toHaveBeenCalledWith(user.id, { fcmToken: user.fcmToken });
  });

  it('persists a changed token', async () => {
    const user = { id: 'user-1', fcmToken: 'old-token' };
    const { service, update, transaction } = fixture(user);

    await UsersService.prototype.updateFcmToken.call(
      service,
      user.id,
      'new-token',
    );

    expect(update).toHaveBeenCalledWith(user.id, {
      fcmToken: 'new-token',
    });
    expect(transaction).toHaveBeenCalledTimes(1);
  });
});
