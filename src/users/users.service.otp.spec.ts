import { PhoneVerificationContext } from './dto/user.dto';
import { UserRole, UserStatus } from './entities/user.entity';
import { In, Not } from 'typeorm';
import { UsersService } from './users.service';

describe('UsersService OTP routes', () => {
  it.each([
    PhoneVerificationContext.REGISTRATION,
    PhoneVerificationContext.LOGIN,
    PhoneVerificationContext.UPDATE,
  ])(
    'sends through the OTP service for %s and preserves the app response',
    async (context) => {
      const sendOtp = jest.fn().mockResolvedValue({ success: true });
      const service = {
        logger: { log: jest.fn(), warn: jest.fn() },
        userRepository: {
          findOne: jest
            .fn()
            .mockResolvedValue(
              context === PhoneVerificationContext.REGISTRATION
                ? null
                : { id: 'user-1' },
            ),
        },
        otpService: { sendOtp },
      } as unknown as UsersService;

      const result: unknown =
        await UsersService.prototype.sendPhoneVerificationOtp.call(service, {
          phone: '+243891234567',
          context,
        });

      expect(sendOtp).toHaveBeenCalledWith('+243891234567');
      expect(result).toEqual({
        message: 'Code de vérification envoyé avec succès',
      });
    },
  );

  it('keeps a new account pending until a phone OTP is verified', async () => {
    const verifyOtp = jest.fn().mockResolvedValue({ valid: true });
    const update = jest.fn().mockResolvedValue({ affected: 1 });
    const service = {
      logger: { log: jest.fn(), warn: jest.fn() },
      otpService: { verifyOtp },
      userRepository: { update },
    } as unknown as UsersService;

    await expect(
      UsersService.prototype.verifyPhoneOtp.call(service, {
        phone: '+243891234567',
        otp: '12345',
      }),
    ).resolves.toMatchObject({ valid: true });
    expect(update).toHaveBeenCalledWith(
      {
        phone: '+243891234567',
        isPhoneVerified: false,
        isActive: true,
        status: Not(In([UserStatus.INACTIVE, UserStatus.SUSPENDED])),
      },
      { isPhoneVerified: true },
    );
  });

  it('does not clear the pending flag for an invalid OTP', async () => {
    const update = jest.fn();
    const service = {
      logger: { log: jest.fn(), warn: jest.fn() },
      otpService: { verifyOtp: jest.fn().mockResolvedValue({ valid: false }) },
      userRepository: { update },
    } as unknown as UsersService;

    await expect(
      UsersService.prototype.verifyPhoneOtp.call(service, {
        phone: '+243891234567',
        otp: '00000',
      }),
    ).rejects.toThrow('Code OTP invalide ou expiré');
    expect(update).not.toHaveBeenCalled();
  });

  it.each([
    { status: UserStatus.INACTIVE, isActive: false },
    { status: UserStatus.SUSPENDED, isActive: false },
    { status: UserStatus.SUSPENDED, isActive: true },
    { status: UserStatus.ACTIVE, isActive: false },
  ])(
    'allows registration OTP for an unavailable account (%j) without changing it',
    async (account) => {
      const sendOtp = jest.fn().mockResolvedValue({ success: true });
      const update = jest.fn();
      const service = {
        logger: { log: jest.fn(), warn: jest.fn() },
        userRepository: {
          findOne: jest.fn().mockResolvedValue({ id: 'old-user', ...account }),
          update,
        },
        otpService: { sendOtp },
      } as unknown as UsersService;
      await expect(
        UsersService.prototype.sendPhoneVerificationOtp.call(service, {
          phone: ' +243891234567 ',
          context: PhoneVerificationContext.REGISTRATION,
        }),
      ).resolves.toMatchObject({
        message: 'Code de vérification envoyé avec succès',
      });
      expect(sendOtp).toHaveBeenCalledWith('+243891234567');
      expect(update).not.toHaveBeenCalled();
    },
  );

  it.each([UserStatus.ACTIVE, UserStatus.PENDING_KYC])(
    'keeps the phone reserved for an enabled %s account',
    async (status) => {
      const sendOtp = jest.fn();
      const service = {
        logger: { log: jest.fn(), warn: jest.fn() },
        userRepository: {
          findOne: jest
            .fn()
            .mockResolvedValue({ id: 'active-user', isActive: true, status }),
        },
        otpService: { sendOtp },
      } as unknown as UsersService;
      await expect(
        UsersService.prototype.sendPhoneVerificationOtp.call(service, {
          phone: '+243891234567',
          context: PhoneVerificationContext.REGISTRATION,
        }),
      ).rejects.toThrow('déjà utilisé');
      expect(sendOtp).not.toHaveBeenCalled();
    },
  );

  it.each([PhoneVerificationContext.LOGIN, PhoneVerificationContext.UPDATE])(
    'does not send a %s OTP to a disabled old account',
    async (context) => {
      const sendOtp = jest.fn();
      const service = {
        logger: { log: jest.fn(), warn: jest.fn() },
        userRepository: {
          findOne: jest
            .fn()
            .mockResolvedValue({
              isActive: false,
              status: UserStatus.SUSPENDED,
            }),
        },
        otpService: { sendOtp },
      } as unknown as UsersService;
      await expect(
        UsersService.prototype.sendPhoneVerificationOtp.call(service, {
          phone: '+243891234567',
          context,
        }),
      ).rejects.toThrow('Aucun compte');
      expect(sendOtp).not.toHaveBeenCalled();
    },
  );

  it('signals the pending verification in the private profile', async () => {
    const user = {
      id: 'user-1',
      phone: '+243891234567',
      isPhoneVerified: false,
      vehicles: [],
    };
    const service = {
      findOne: jest.fn().mockResolvedValue(user),
      enrichUserWithPresignedUrls: jest.fn().mockResolvedValue(user),
      toSafeUser: jest.fn().mockReturnValue(user),
      tripRepository: { count: jest.fn().mockResolvedValue(0) },
      bookingRepository: {
        count: jest.fn().mockResolvedValue(0),
        createQueryBuilder: jest.fn().mockReturnValue({
          innerJoin: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          getCount: jest.fn().mockResolvedValue(0),
        }),
      },
      messageRepository: { count: jest.fn().mockResolvedValue(0) },
      subscriptionsService: {
        getPremiumOverview: jest.fn().mockResolvedValue({
          isPremium: false,
          premiumBadgeEnabled: false,
        }),
      },
    } as unknown as UsersService;

    const result: unknown = await UsersService.prototype.getProfileSummary.call(
      service,
      user.id,
    );
    expect(result).toMatchObject({
      user: { isPhoneVerified: false, phoneVerificationRequired: true },
    });
  });

  it('requires a new OTP after a verified account changes phone', async () => {
    const user = {
      id: 'user-1',
      phone: '+243891234567',
      firstName: 'Test',
      lastName: 'User',
      role: UserRole.PASSENGER,
      gender: null,
      profilePicture: null,
      kycDocuments: [],
      isPhoneVerified: true,
    };
    const update = jest
      .fn<Promise<{ affected: number }>, [string, Record<string, unknown>]>()
      .mockResolvedValue({ affected: 1 });
    const service = {
      logger: { log: jest.fn(), warn: jest.fn() },
      findOne: jest.fn().mockResolvedValue(user),
      userRepository: {
        findOne: jest.fn().mockResolvedValue(null),
        update,
      },
      enrichUserWithPresignedUrls: jest.fn().mockResolvedValue(user),
    } as unknown as UsersService;

    await UsersService.prototype.updateProfile.call(service, user.id, {
      phone: '+243899999999',
    });
    expect(update).toHaveBeenCalledWith(
      user.id,
      expect.objectContaining({
        phone: '+243899999999',
        isPhoneVerified: false,
      }),
    );

    update.mockClear();
    await UsersService.prototype.updateProfile.call(service, user.id, {
      phone: '+243899999999',
    });
    const unchangedPhoneUpdate: unknown = update.mock.calls[0][1];
    expect(unchangedPhoneUpdate).not.toHaveProperty('isPhoneVerified');
  });
});
