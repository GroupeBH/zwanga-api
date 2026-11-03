import { Logger } from '@nestjs/common';
import { validate } from 'class-validator';
import * as bcrypt from 'bcrypt';
import { UsersService } from './users.service';
import { ChangePinDto } from './dto/user.dto';
import { UserRole, UserStatus } from './entities/user.entity';

describe('Authenticated PIN change requires old PIN and its own OTP', () => {
  let password: string;
  beforeAll(async () => {
    password = await bcrypt.hash('1234', 4);
  });
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  const fixture = (patch = {}) => {
    const user = {
      id: 'user-a',
      phone: '+243900000000',
      password,
      role: UserRole.PASSENGER,
      status: UserStatus.ACTIVE,
      isActive: true,
      ...patch,
    };
    const userRepository = {
      findOne: jest.fn().mockResolvedValue(user),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    const otpService = {
      sendOtp: jest.fn().mockResolvedValue({
        success: true,
        codeLength: 6,
        expiresInSeconds: 895,
        otp: '123456',
      }),
      verifyOtp: jest.fn().mockResolvedValue({ valid: true }),
    };
    const service = Object.create(UsersService.prototype) as UsersService;
    Object.assign(service, {
      userRepository,
      otpService,
      logger: new Logger('UsersService'),
    });
    return { service, userRepository, otpService, user };
  };
  const dto = { oldPin: '1234', newPin: '5678', otp: '123456' };

  it('requires a six-digit OTP at the DTO boundary', async () => {
    for (const otp of [undefined, '', '12345', '1234567', 'abcdef']) {
      const errors = await validate(
        Object.assign(new ChangePinDto(), { ...dto, otp }),
      );
      expect(errors.map((error) => error.property)).toContain('otp');
    }
    expect(await validate(Object.assign(new ChangePinDto(), dto))).toEqual([]);
  });

  it('sends only to the stored account phone and never returns the code', async () => {
    const f = fixture();
    expect(await f.service.requestPinChangeOtp('user-a')).toEqual({
      message: 'Code de modification envoyé par SMS au numéro de votre compte.',
      codeLength: 6,
      expiresInSeconds: 895,
    });
    expect(f.otpService.sendOtp).toHaveBeenCalledWith(
      f.user.phone,
      'pin_change',
    );
    expect(f.userRepository.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'user-a' } }),
    );
  });

  it.each([
    { isActive: false },
    { status: UserStatus.SUSPENDED },
    { status: UserStatus.INACTIVE },
    { role: UserRole.ADMIN },
    { phone: '' },
    { password: '' },
  ])(
    'rejects an ineligible account without sending an SMS: %j',
    async (patch) => {
      const f = fixture(patch);
      await expect(
        f.service.requestPinChangeOtp('user-a'),
      ).rejects.toMatchObject({ status: 400 });
      expect(f.otpService.sendOtp).not.toHaveBeenCalled();
    },
  );

  it('checks the old PIN before consuming an OTP', async () => {
    const f = fixture();
    await expect(
      f.service.changePin('user-a', { ...dto, oldPin: '9999' }),
    ).rejects.toMatchObject({ status: 401 });
    expect(f.otpService.verifyOtp).not.toHaveBeenCalled();
    expect(f.userRepository.update).not.toHaveBeenCalled();
  });

  it('refuses a missing OTP even if DTO validation were bypassed', async () => {
    const f = fixture();
    await expect(
      f.service.changePin('user-a', { ...dto, otp: '' }),
    ).rejects.toMatchObject({
      response: { code: 'PIN_CHANGE_OTP_REQUIRED' },
    });
    expect(f.otpService.verifyOtp).not.toHaveBeenCalled();
    expect(f.userRepository.update).not.toHaveBeenCalled();
  });

  it('never updates the PIN for an expired, incorrect or replayed code', async () => {
    const f = fixture();
    f.otpService.verifyOtp.mockResolvedValue({ valid: false });
    await expect(f.service.changePin('user-a', dto)).rejects.toMatchObject({
      response: { code: 'PIN_CHANGE_OTP_INVALID' },
    });
    expect(f.userRepository.update).not.toHaveBeenCalled();
  });

  it('checks the dedicated purpose and updates only an unchanged active account', async () => {
    const f = fixture();
    await f.service.changePin('user-a', dto);
    expect(f.otpService.verifyOtp).toHaveBeenCalledWith(
      f.user.phone,
      dto.otp,
      'pin_change',
    );
    const [where, updated] = f.userRepository.update.mock.calls[0] as [
      Record<string, unknown>,
      { password: string; refreshToken: null; accessToken: null },
    ];
    expect(where).toMatchObject({
      id: 'user-a',
      phone: f.user.phone,
      password,
      role: f.user.role,
      isActive: true,
    });
    expect(await bcrypt.compare(dto.newPin, updated.password)).toBe(true);
    expect(updated.refreshToken).toBeNull();
    expect(updated.accessToken).toBeNull();
  });

  it('reports concurrent account changes rather than announcing success', async () => {
    const f = fixture();
    f.userRepository.update.mockResolvedValue({ affected: 0 });
    await expect(f.service.changePin('user-a', dto)).rejects.toMatchObject({
      status: 409,
    });
  });
});
