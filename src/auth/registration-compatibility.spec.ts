import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { AppleMobileAuthDto, GoogleMobileAuthDto, RegisterDto } from './dto/auth.dto';
import { AuthService } from './auth.service';
import { UserRole } from '../users/entities/user.entity';

const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  transformOptions: { enableImplicitConversion: true },
});
const common = {
  phone: '+243000000000', firstName: 'Test', lastName: 'Example',
  role: UserRole.PASSENGER, referralCode: 'ZWTEST001',
};
const scenarios = [
  { dto: RegisterDto, body: { ...common, pin: '1234' } },
  { dto: AppleMobileAuthDto, body: { ...common, idToken: 'test-token', nonce: 'test-nonce' } },
  { dto: GoogleMobileAuthDto, body: { ...common, idToken: 'test-token' } },
];

describe.each(scenarios)('$dto.name legacy email compatibility', ({ dto, body }) => {
  const transform = (value: object) => pipe.transform(value, { type: 'body', metatype: dto });

  it.each([undefined, null, '', 'legacy@example.invalid', { unexpected: 'not trusted' }])(
    'discards the obsolete field before application logic (%j)', async (email) => {
      const result = await transform({ ...body, email });
      expect(result.email).toBeUndefined();
      expect(result).toMatchObject(body);
      expect(JSON.stringify(result)).not.toContain('email');
    },
  );

  it('does not relax unknown fields or privileged flags', async () => {
    for (const extra of [{ unexpected: true }, { isEmailVerified: true }, { appleId: 'forged-id' }]) {
      await expect(transform({ ...body, email: 'legacy@example.invalid', ...extra }))
        .rejects.toBeInstanceOf(BadRequestException);
    }
  });

  it('retains role and nested vehicle validation', async () => {
    await expect(transform({ ...body, role: 'admin' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(transform({ ...body, vehicle: { type: 'car', unexpected: true } }))
      .rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('Apple email provenance', () => {
  it('passes only the verified token email to account resolution', async () => {
    const service = Object.create(AuthService.prototype) as AuthService;
    const verified = { appleId: 'verified-sub', email: 'relay@example.invalid', emailVerified: true };
    const verifyAppleIdToken = jest.fn().mockResolvedValue(verified);
    const validateAppleUser = jest.fn().mockResolvedValue({ accessToken: 'test', refreshToken: 'test' });
    Object.assign(service, { verifyAppleIdToken, validateAppleUser });
    const dto = await pipe.transform({
      ...common, idToken: 'test-token', nonce: 'test-nonce', email: 'untrusted@example.invalid',
    }, { type: 'body', metatype: AppleMobileAuthDto });

    await service.appleMobileLogin(dto);
    expect(verifyAppleIdToken).toHaveBeenCalledWith('test-token', 'test-nonce');
    expect(validateAppleUser).toHaveBeenCalledWith(
      { ...verified, firstName: common.firstName, lastName: common.lastName }, common.phone, dto,
    );
    expect(dto.email).toBeUndefined();
  });

  it('never attempts registration when token verification fails', async () => {
    const service = Object.create(AuthService.prototype) as AuthService;
    const validateAppleUser = jest.fn();
    Object.assign(service, {
      verifyAppleIdToken: jest.fn().mockRejectedValue(new Error('token rejected')),
      validateAppleUser,
    });
    const dto = plainToInstance(AppleMobileAuthDto, { idToken: 'invalid', email: 'untrusted@example.invalid' });
    await expect(service.appleMobileLogin(dto)).rejects.toThrow('token rejected');
    expect(validateAppleUser).not.toHaveBeenCalled();
  });
});
