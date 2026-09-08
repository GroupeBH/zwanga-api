import { UsersService } from './users.service';

describe('UsersService.updateFcmToken', () => {
  it('does not write when the token is already current', async () => {
    const user = { id: 'user-1', fcmToken: 'same-token' };
    const save = jest.fn();
    const service = {
      logger: { debug: jest.fn() },
      findOne: jest.fn().mockResolvedValue(user),
      userRepository: { save },
    } as unknown as UsersService;

    await UsersService.prototype.updateFcmToken.call(
      service,
      user.id,
      user.fcmToken,
    );

    expect(save).not.toHaveBeenCalled();
  });

  it('persists a changed token', async () => {
    const user = { id: 'user-1', fcmToken: 'old-token' };
    const save = jest.fn().mockResolvedValue(user);
    const service = {
      logger: { debug: jest.fn() },
      findOne: jest.fn().mockResolvedValue(user),
      userRepository: { save },
    } as unknown as UsersService;

    await UsersService.prototype.updateFcmToken.call(
      service,
      user.id,
      'new-token',
    );

    expect(user.fcmToken).toBe('new-token');
    expect(save).toHaveBeenCalledWith(user);
  });
});
