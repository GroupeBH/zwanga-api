import { BadRequestException } from '@nestjs/common';
import { AuthService } from './auth.service';
import { UserRole, UserStatus } from '../users/entities/user.entity';

function fixture() {
  const users = {
    findOne: jest.fn().mockResolvedValue(null),
    create: jest.fn((value) => value),
    save: jest.fn(async (value) => ({
      isActive: true,
      ...value,
      id: 'new-account',
    })),
    update: jest.fn(),
    manager: { transaction: jest.fn() },
  };
  users.manager.transaction.mockImplementation((callback) =>
    callback({
      query: jest.fn().mockResolvedValue([]),
      getRepository: () => users,
    }),
  );
  const jwt = { signAsync: jest.fn(async () => 'test-token') };
  const vehicles = { create: jest.fn() };
  const service = new AuthService(
    users as any,
    {} as any,
    jwt as any,
    { get: jest.fn() } as any,
    {} as any,
    vehicles as any,
    { assertReferralAttribution: jest.fn(), registerUser: jest.fn() } as any,
    {} as any,
    {} as any,
  );
  const signup = (
    provider: string,
    role: UserRole,
    isDriver: boolean,
    vehicle?: any,
  ) => {
    const details = { firstName: 'Test', lastName: 'Compte' };
    const options = { ...details, role, isDriver, vehicle };
    if (provider === 'phone')
      return service.register({
        ...options,
        phone: '+243900000000',
        pin: '1234',
      });
    if (provider === 'google')
      return service.validateGoogleUser(
        {
          ...details,
          googleId: 'google-test',
          email: 'test@example.invalid',
          profilePicture: null,
        },
        '+243900000000',
        null,
        options,
      );
    return service.validateAppleUser(
      {
        ...details,
        appleId: 'apple-test',
        email: 'test@example.invalid',
        emailVerified: true,
      },
      '+243900000000',
      options,
    );
  };
  return { users, jwt, vehicles, signup };
}

for (const provider of ['phone', 'google', 'apple'])
  describe(`${provider} signup`, () => {
    it.each([
      { status: UserStatus.INACTIVE, isActive: false },
      { status: UserStatus.SUSPENDED, isActive: true },
      { status: UserStatus.ACTIVE, isActive: false },
    ])(
      'creates a separate account for an unavailable phone owner (%j)',
      async (state) => {
        const f = fixture();
        f.users.findOne.mockImplementation(async ({ where }) => {
          const conditions = Array.isArray(where) ? where : [where];
          return conditions.some(
            (condition) => condition.phone === '+243900000000',
          )
            ? {
                id: 'old-account',
                phone: '+243900000000',
                ...state,
                role: UserRole.DRIVER,
                isPhoneVerified: true,
              }
            : null;
        });
        await f.signup(provider, UserRole.PASSENGER, false);
        expect(f.users.update).toHaveBeenCalledWith(
          'old-account',
          expect.objectContaining({
            phone: expect.any(Function),
            isActive: false,
            isPhoneVerified: false,
            accessToken: null,
            refreshToken: null,
            fcmToken: null,
          }),
        );
        expect(f.users.save).toHaveBeenCalledWith(
          expect.objectContaining({
            role: UserRole.PASSENGER,
            isPhoneVerified: false,
          }),
        );
        expect(f.users.save.mock.calls[0][0]).not.toHaveProperty('id');
        expect(f.jwt.signAsync).toHaveBeenCalledWith(
          expect.objectContaining({
            sub: 'new-account',
            role: UserRole.PASSENGER,
          }),
          expect.anything(),
        );
      },
    );

    it.each([UserStatus.ACTIVE, UserStatus.PENDING_KYC])(
      'rejects a phone reserved by an enabled %s owner',
      async (status) => {
        const f = fixture();
        f.users.findOne.mockImplementation(async ({ where }) => {
          const conditions = Array.isArray(where) ? where : [where];
          return conditions.some(
            (condition) => condition.phone === '+243900000000',
          )
            ? { id: 'existing-account', isActive: true, status }
            : null;
        });
        await expect(
          f.signup(provider, UserRole.PASSENGER, false),
        ).rejects.toThrow('déjà');
        expect(f.users.save).not.toHaveBeenCalled();
        expect(f.users.update).not.toHaveBeenCalled();
        expect(f.jwt.signAsync).not.toHaveBeenCalled();
      },
    );

    it('persists a passenger, no driver intent, and passenger tokens', async () => {
      const f = fixture();
      await f.signup(provider, UserRole.PASSENGER, false);
      expect(f.users.create).toHaveBeenCalledWith(
        expect.objectContaining({
          role: UserRole.PASSENGER,
          isDriver: false,
          driverOnboardingRequestedAt: null,
        }),
      );
      expect(f.vehicles.create).not.toHaveBeenCalled();
      expect(f.jwt.signAsync).toHaveBeenCalledWith(
        expect.objectContaining({ role: UserRole.PASSENGER }),
        expect.anything(),
      );
      for (const [, changes] of f.users.update.mock.calls as any[]) {
        expect(changes).not.toHaveProperty('role');
        expect(changes).not.toHaveProperty('isDriver');
      }
    });

    it('records driver intent and vehicle without granting driver permission', async () => {
      const f = fixture(),
        vehicle = { type: 'car', licensePlate: '1234AB56' };
      await f.signup(provider, UserRole.DRIVER, true, vehicle);
      expect(f.users.create).toHaveBeenCalledWith(
        expect.objectContaining({
          role: UserRole.PASSENGER,
          isDriver: false,
          driverOnboardingRequestedAt: expect.any(Date),
        }),
      );
      expect(f.vehicles.create).toHaveBeenCalledWith('new-account', vehicle);
      expect(f.jwt.signAsync).toHaveBeenCalledWith(
        expect.objectContaining({ role: UserRole.PASSENGER }),
        expect.anything(),
      );
    });

    it.each([true, false])(
      'rejects contradictory passenger/vehicle inputs before creating an account (flag=%s)',
      async (flag) => {
        const f = fixture();
        await expect(
          f.signup(
            provider,
            UserRole.PASSENGER,
            flag,
            flag ? undefined : { type: 'car' },
          ),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(f.users.save).not.toHaveBeenCalled();
        expect(f.vehicles.create).not.toHaveBeenCalled();
      },
    );
  });
