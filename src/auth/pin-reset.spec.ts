import { BadRequestException } from '@nestjs/common';
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
import { OTP_SMS_MESSAGES } from '../keccel-otp/otp-messages';

describe('PIN reset security', () => {
  const userId = '123e4567-e89b-42d3-a456-426614174000';
  let user: User;
  let userRepository: {
    findOne: jest.Mock;
    save: jest.Mock;
    update: jest.Mock;
  };
  let keccelOtpService: {
    sendOtp: jest.Mock;
    verifyOtp: jest.Mock;
  };
  let redisService: {
    get: jest.Mock;
    set: jest.Mock;
    consumeIfValueMatches: jest.Mock;
  };
  let service: AuthService;

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
    } as User;
    userRepository = {
      findOne: jest.fn().mockResolvedValue(user),
      save: jest.fn().mockImplementation((value) => Promise.resolve(value)),
      update: jest.fn(async (_id, patch) => Object.assign(user, patch)),
    };
    keccelOtpService = {
      sendOtp: jest.fn().mockResolvedValue({ success: true }),
      verifyOtp: jest.fn().mockResolvedValue({ valid: true }),
    };
    redisService = {
      get: jest.fn().mockResolvedValue('pending'),
      set: jest.fn().mockResolvedValue(undefined),
      consumeIfValueMatches: jest.fn().mockResolvedValue(true),
    };
    service = new AuthService(
      userRepository as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      keccelOtpService as any,
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
    expect(keccelOtpService.sendOtp).not.toHaveBeenCalled();
  });

  it('sends a six-digit OTP with a five-minute lifetime', async () => {
    await service.requestPinResetOtp(
      Object.assign(new PinResetRequestDto(), { phone: user.phone }),
    );

    expect(keccelOtpService.sendOtp).toHaveBeenCalledWith(
      user.phone,
      OTP_SMS_MESSAGES.pinReset,
      6,
      300,
    );
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

    expect(keccelOtpService.verifyOtp).not.toHaveBeenCalled();
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
    expect(userRepository.update).toHaveBeenCalledWith(user.id, {
      password: user.password, accessToken: null, refreshToken: null,
    });

    redisService.consumeIfValueMatches.mockResolvedValueOnce(false);
    await expect(service.resetPin(dto)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
