import { UsersService } from './users.service';

describe('UsersService.updateFcmToken', () => {
  it('does not write when the token is already current', async () => {
    const user = { id: 'user-1', fcmToken: 'same-token' };
    const update = jest.fn();
    const service = {
      logger: { debug: jest.fn() },
      findOne: jest.fn().mockResolvedValue(user),
      userRepository: { update },
    } as unknown as UsersService;

    await UsersService.prototype.updateFcmToken.call(
      service,
      user.id,
      user.fcmToken,
    );

    expect(update).not.toHaveBeenCalled();
  });

  it('persists a changed token', async () => {
    const user = { id: 'user-1', fcmToken: 'old-token' };
    const update = jest.fn().mockResolvedValue({ affected: 1 });
    const service = {
      logger: { debug: jest.fn() },
      findOne: jest.fn().mockResolvedValue(user),
      userRepository: { update },
    } as unknown as UsersService;

    await UsersService.prototype.updateFcmToken.call(
      service,
      user.id,
      'new-token',
    );

    expect(update).toHaveBeenCalledWith(user.id, {
      fcmToken: 'new-token',
    });
  });
});
