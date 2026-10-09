import {
  BadRequestException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { validate } from 'class-validator';
import * as bcrypt from 'bcrypt';
import { AuthService } from './auth.service';
import {
  LoginDto,
  PinResetConfirmDto,
  PinResetRequestDto,
  PinResetVerifyOtpDto,
} from './dto/auth.dto';
import { ChangePinDto } from '../users/dto/user.dto';
import { User, UserRole, UserStatus } from '../users/entities/user.entity';
import { UsersService } from '../users/users.service';

describe('PIN reset security', () => {
  const userId = '123e4567-e89b-42d3-a456-426614174000';
  let user: User;
  let userRepository: {
    findOne: jest.Mock;
    save: jest.Mock;
    update: jest.Mock;
    manager: { transaction: jest.Mock };
  };
  let otpService: {
    sendOtp: jest.Mock;
    verifyOtp: jest.Mock;
  };
  let redisService: {
    get: jest.Mock;
    set: jest.Mock;
    consumeIfValueMatches: jest.Mock;
  };
  let service: AuthService;
  let transactionManager: {
    findOne: jest.Mock;
    update: jest.Mock;
    query: jest.Mock;
  };
  let failCommit: boolean;
  let values: Map<string, string>;

  afterEach(() => jest.restoreAllMocks());

  beforeEach(() => {
    user = {
      id: userId,
      phone: '+243831919710',
      role: UserRole.PASSENGER,
      status: UserStatus.ACTIVE,
      isActive: true,
      password: 'previous-hash',
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      lastPinResetTokenHash: null,
    } as User;
    failCommit = false;
    values = new Map([[`auth:pin-reset-otp:${userId}`, 'pending']]);
    transactionManager = {
      query: jest.fn().mockResolvedValue([]),
      findOne: jest.fn(async () => ({ ...user })),
      update: jest.fn(async (_entity, _id, patch) =>
        Object.assign(user, patch),
      ),
    };
    userRepository = {
      findOne: jest.fn().mockResolvedValue(user),
      save: jest.fn().mockImplementation((value) => Promise.resolve(value)),
      update: jest.fn(async (_id, patch) => Object.assign(user, patch)),
      manager: {
        transaction: jest.fn(async (work) => {
          const previous = { ...user };
          try {
            const result = await work(transactionManager);
            if (failCommit) throw new Error('commit failed');
            return result;
          } catch (error) {
            Object.assign(user, previous);
            throw error;
          }
        }),
      },
    };
    otpService = {
      sendOtp: jest.fn().mockResolvedValue({ success: true }),
      verifyOtp: jest.fn().mockResolvedValue({ valid: true }),
    };
    redisService = {
      get: jest.fn(async (key) => values.get(key) ?? null),
      set: jest.fn(async (key, value) => {
        values.set(key, value);
      }),
      consumeIfValueMatches: jest.fn(async (key, expected) => {
        if (values.get(key) !== expected) return false;
        values.delete(key);
        return true;
      }),
    };
    service = new AuthService(
      userRepository as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      otpService as any,
      redisService as any,
    );
  });

  it('rejects newPin on login and requires the current PIN', async () => {
    const dto = Object.assign(new LoginDto(), {
      phone: user.phone,
      newPin: '5678',
    });

    const errors = await validate(dto, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });

    expect(errors.map((error) => error.property)).toEqual(
      expect.arrayContaining(['newPin', 'pin']),
    );
  });

  it('requires the old PIN on the authenticated change route', async () => {
    const dto = Object.assign(new ChangePinDto(), { newPin: '5678' });

    const errors = await validate(dto);

    expect(errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ property: 'oldPin' })]),
    );
  });

  it('defensively refuses a PIN change without the old PIN', async () => {
    const usersService = new UsersService(
      userRepository as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    await expect(
      usersService.changePin(userId, { newPin: '5678' } as ChangePinDto),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(userRepository.save).not.toHaveBeenCalled();
  });

  it('does not reveal whether an account exists when requesting an OTP', async () => {
    userRepository.findOne.mockResolvedValue(null);

    const result = await service.requestPinResetOtp(
      Object.assign(new PinResetRequestDto(), { phone: '+243000000000' }),
    );

    expect(result.message).toContain('Si ce compte');
    expect(otpService.sendOtp).not.toHaveBeenCalled();
  });

  it('requests a PIN reset OTP with a five-minute pending window', async () => {
    await service.requestPinResetOtp(
      Object.assign(new PinResetRequestDto(), { phone: user.phone }),
    );

    expect(otpService.sendOtp).toHaveBeenCalledWith(user.phone, 'pin_reset');
    expect(redisService.set).toHaveBeenCalledWith(
      `auth:pin-reset-otp:${userId}`,
      'pending',
      300,
    );
  });

  it('stores only a hash of the five-minute reset token', async () => {
    const result = await service.verifyPinResetOtp(
      Object.assign(new PinResetVerifyOtpDto(), {
        phone: user.phone,
        otp: '123456',
      }),
    );

    expect(result.expiresInSeconds).toBe(300);
    expect(result.resetToken).toMatch(
      new RegExp(`^${userId}\\.[A-Za-z0-9_-]{43}$`),
    );
    expect(redisService.consumeIfValueMatches).toHaveBeenCalledWith(
      `auth:pin-reset-otp:${userId}`,
      'pending',
    );
    expect(redisService.set).toHaveBeenCalledWith(
      `auth:pin-reset:${userId}`,
      expect.stringMatching(/^[a-f0-9]{64}$/),
      300,
    );
  });

  it('does not accept an OTP outside a pending PIN reset request', async () => {
    redisService.get.mockResolvedValueOnce(null);

    await expect(
      service.verifyPinResetOtp(
        Object.assign(new PinResetVerifyOtpDto(), {
          phone: user.phone,
          otp: '123456',
        }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(otpService.verifyOtp).not.toHaveBeenCalled();
    expect(redisService.set).not.toHaveBeenCalled();
  });

  it('consumes the token once, changes the PIN, and revokes sessions', async () => {
    const { resetToken } = await service.verifyPinResetOtp(
      Object.assign(new PinResetVerifyOtpDto(), {
        phone: user.phone,
        otp: '123456',
      }),
    );

    const dto = Object.assign(new PinResetConfirmDto(), {
      resetToken,
      newPin: '5678',
    });
    await service.resetPin(dto);

    expect(redisService.consumeIfValueMatches).toHaveBeenCalledWith(
      `auth:pin-reset:${userId}`,
      expect.stringMatching(/^[a-f0-9]{64}$/),
    );
    expect(await bcrypt.compare('5678', user.password)).toBe(true);
    expect(user.refreshToken).toBeNull();
    expect(user.accessToken).toBeNull();
    expect(transactionManager.update).toHaveBeenCalledWith(User, user.id, {
      password: user.password,
      accessToken: null,
      refreshToken: null,
      lastPinResetTokenHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(transactionManager.findOne).toHaveBeenCalledWith(
      User,
      expect.objectContaining({
        lock: { mode: 'for_no_key_update' },
      }),
    );

    redisService.consumeIfValueMatches.mockResolvedValueOnce(false);
    await expect(service.resetPin(dto)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  async function issueProof() {
    const { resetToken } = await service.verifyPinResetOtp(
      Object.assign(new PinResetVerifyOtpDto(), {
        phone: user.phone,
        otp: '123456',
      }),
    );
    return Object.assign(new PinResetConfirmDto(), {
      resetToken,
      newPin: '5678',
    });
  }

  it('keeps the proof and old PIN after a database write failure, allowing a retry', async () => {
    const dto = await issueProof();
    const proof = values.get(`auth:pin-reset:${userId}`);
    transactionManager.update.mockRejectedValueOnce(
      new Error('database unavailable'),
    );
    await expect(service.resetPin(dto)).rejects.toThrow('database unavailable');
    expect(user.password).toBe('previous-hash');
    expect(user.lastPinResetTokenHash).toBeNull();
    expect(values.get(`auth:pin-reset:${userId}`)).toBe(proof);
    await expect(service.resetPin(dto)).resolves.toHaveProperty('message');
    expect(await bcrypt.compare('5678', user.password)).toBe(true);
  });

  it('does not consume a proof when a deferred trigger fails at COMMIT', async () => {
    const dto = await issueProof();
    failCommit = true;
    await expect(service.resetPin(dto)).rejects.toThrow('commit failed');
    expect(user.password).toBe('previous-hash');
    expect(values.has(`auth:pin-reset:${userId}`)).toBe(true);
    failCommit = false;
    await expect(service.resetPin(dto)).resolves.toHaveProperty('message');
  });

  it('returns success and prevents replay even if Redis cleanup fails', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const dto = await issueProof();
    redisService.consumeIfValueMatches.mockRejectedValueOnce(
      new Error('redis down'),
    );
    await expect(service.resetPin(dto)).resolves.toHaveProperty('message');
    expect(values.has(`auth:pin-reset:${userId}`)).toBe(true);
    await expect(service.resetPin(dto)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(transactionManager.update).toHaveBeenCalledTimes(1);
  });

  it('does not delete a newer proof during cleanup', async () => {
    const dto = await issueProof();
    transactionManager.update.mockImplementationOnce(
      async (_entity, _id, patch) => {
        Object.assign(user, patch);
        values.set(`auth:pin-reset:${userId}`, 'newer-proof');
      },
    );
    await service.resetPin(dto);
    expect(values.get(`auth:pin-reset:${userId}`)).toBe('newer-proof');
  });

  it('bounds a stalled Redis read while holding a user lock and keeps the proof', async () => {
    const dto = await issueProof();
    redisService.get
      .mockResolvedValueOnce(values.get(`auth:pin-reset:${userId}`))
      .mockImplementationOnce(() => new Promise(() => undefined));
    await expect(service.resetPin(dto)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(transactionManager.update).not.toHaveBeenCalled();
    expect(user.lastPinResetTokenHash).toBeNull();
    expect(values.has(`auth:pin-reset:${userId}`)).toBe(true);
  });

  it.each([null, 'replacement-proof'])(
    'rechecks expiry/replacement under the row lock (%s)',
    async (proof) => {
      const dto = await issueProof();
      redisService.get
        .mockResolvedValueOnce(values.get(`auth:pin-reset:${userId}`))
        .mockResolvedValueOnce(proof);
      await expect(service.resetPin(dto)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(transactionManager.update).not.toHaveBeenCalled();
    },
  );

  it.each([
    { isActive: false },
    { status: UserStatus.SUSPENDED },
    { status: UserStatus.INACTIVE },
    { role: UserRole.ADMIN },
    { role: UserRole.SUPER_ADMIN },
  ])(
    'rechecks account eligibility after OTP verification (%j)',
    async (patch) => {
      const dto = await issueProof();
      Object.assign(user, patch);
      await expect(service.resetPin(dto)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(transactionManager.update).not.toHaveBeenCalled();
    },
  );
});
