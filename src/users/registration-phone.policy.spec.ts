import { User, UserStatus } from './entities/user.entity';
import {
  accountReservesPhone,
  saveRegistrationWithPhone,
} from './registration-phone.policy';

describe('Phone ownership during registration', () => {
  const phone = '+243890000001';
  function fixture(previous: Partial<User> | null) {
    const users = {
      findOne: jest.fn().mockResolvedValue(previous),
      update: jest.fn(),
      save: jest.fn(async (user) => ({ ...user, id: 'new-user' })),
    };
    const manager = { query: jest.fn(), getRepository: jest.fn(() => users) };
    const repository = {
      manager: { transaction: jest.fn((callback) => callback(manager)) },
    };
    const fresh = {
      phone,
      firstName: 'Nouveau',
      lastName: 'Compte',
      isPhoneVerified: false,
      status: UserStatus.PENDING_KYC,
    } as User;
    return { users, manager, repository, fresh };
  }

  it.each([UserStatus.ACTIVE, UserStatus.PENDING_KYC])(
    'treats %s as occupied when enabled',
    (status) => {
      expect(accountReservesPhone({ status, isActive: true })).toBe(true);
    },
  );

  it.each([
    { status: UserStatus.ACTIVE, isActive: false },
    { status: UserStatus.INACTIVE, isActive: false },
    { status: UserStatus.INACTIVE, isActive: true },
    { status: UserStatus.SUSPENDED, isActive: true },
    { status: UserStatus.SUSPENDED, isActive: false },
  ])(
    'releases the unavailable owner (%j) only within the insert transaction',
    async (state) => {
      const f = fixture({ id: 'old-user', phone, ...state });
      const result = await saveRegistrationWithPhone(
        f.repository as any,
        f.fresh,
      );
      expect(result.id).toBe('new-user');
      expect(result.isPhoneVerified).toBe(false);
      expect(f.manager.query).toHaveBeenCalledWith(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [`zwanga:registration-phone:${phone}`],
      );
      expect(f.users.findOne).toHaveBeenCalledWith({
        where: { phone },
        lock: { mode: 'pessimistic_write' },
      });
      expect(f.users.update).toHaveBeenCalledWith(
        'old-user',
        expect.objectContaining({
          isActive: false,
          isPhoneVerified: false,
          accessToken: null,
          refreshToken: null,
          fcmToken: null,
        }),
      );
      const patch = f.users.update.mock.calls[0][1];
      expect(patch.phone()).toBe('NULL');
      expect(patch).not.toHaveProperty('status');
      expect(patch).not.toHaveProperty('role');
      expect(patch).not.toHaveProperty('email');
      expect(f.repository.manager.transaction).toHaveBeenCalledTimes(1);
      expect(f.users.save).toHaveBeenCalledWith(f.fresh);
    },
  );

  it('does not mutate an active owner found by the final race check', async () => {
    const f = fixture({
      id: 'active',
      phone,
      status: UserStatus.ACTIVE,
      isActive: true,
    });
    await expect(
      saveRegistrationWithPhone(f.repository as any, f.fresh),
    ).rejects.toThrow('déjà utilisé');
    expect(f.users.update).not.toHaveBeenCalled();
    expect(f.users.save).not.toHaveBeenCalled();
  });

  it('creates a fresh account when deletion has already released the phone', async () => {
    const f = fixture(null);
    await saveRegistrationWithPhone(f.repository as any, f.fresh);
    expect(f.users.update).not.toHaveBeenCalled();
    expect(f.users.save).toHaveBeenCalledWith(f.fresh);
  });
});
