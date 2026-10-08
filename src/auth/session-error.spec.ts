import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { rethrowSessionError } from './session-error';

describe('session error classification', () => {
  it.each(['JsonWebTokenError', 'TokenExpiredError', 'NotBeforeError'])('%s remains a definitive rejection', name => {
    expect(() => rethrowSessionError(Object.assign(new Error(), { name }))).toThrow(UnauthorizedException);
  });
  it('preserves business refusals', () => {
    const error = new ForbiddenException();
    expect(() => rethrowSessionError(error)).toThrow(error);
  });
  it.each(['read', 'write'])('refresh %s failure returns 503, not 401', async phase => {
    const service = Object.create(AuthService.prototype);
    Object.assign(service, {
      jwtService: { verifyAsync: jest.fn().mockResolvedValue({ sub: 'synthetic-account' }) },
      configService: { get: () => 'synthetic-config' },
      userRepository: { findOne: phase === 'read' ? jest.fn().mockRejectedValue(new Error('database unavailable')) :
        jest.fn().mockResolvedValue({ refreshToken: 'synthetic-refresh' }) },
      assertUserCanAuthenticate: jest.fn(),
      generateTokens: jest.fn().mockRejectedValue(new Error('write unavailable')),
    });
    await expect(service.refreshToken({ refreshToken: 'synthetic-refresh' })).rejects.toMatchObject({ status: 503 });
  });
  it('ordinary JWT identity lookup failure also returns 503', async () => {
    const strategy = Object.create(JwtStrategy.prototype);
    strategy.usersService = { findAuthIdentity: jest.fn().mockRejectedValue(new Error('database unavailable')) };
    await expect(strategy.validate({ sub: 'synthetic-account' })).rejects.toMatchObject({ status: 503 });
    strategy.usersService.findAuthIdentity.mockResolvedValue(null);
    await expect(strategy.validate({ sub: 'synthetic-account' })).rejects.toMatchObject({ status: 401 });
  });
});
