import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { JwtStrategy } from './jwt.strategy';
import { tokenFingerprint } from '../token-fingerprint';
import { UserStatus } from '../../users/entities/user.entity';

describe('HTTP session revocation', () => {
  const token = 'synthetic-access-token';
  const request = { headers: { authorization: `Bearer ${token}` } } as Request;
  const payload = { sub: 'user', email: '', role: 'passenger' };
  function fixture(stored: string | null) {
    const user = {
      id: 'user',
      role: 'passenger',
      phone: '+243000000000',
      status: UserStatus.ACTIVE,
      isActive: true,
      accessToken: stored,
    };
    const users = { findAuthIdentity: jest.fn(async () => user) };
    return {
      user,
      strategy: new JwtStrategy(
        new ConfigService({ JWT_SECRET: 'test-only-secret' }),
        users as never,
      ),
    };
  }
  it.each([token, tokenFingerprint(token)])(
    'accepts a current legacy or fingerprinted session (%s)',
    async (stored) => {
      const { strategy } = fixture(stored);
      const result = await strategy.validate(request, payload);
      expect(result).toMatchObject({ userId: 'user' });
      expect(result).not.toHaveProperty('accessToken');
    },
  );
  it.each([null, tokenFingerprint('revoked-token')])(
    'rejects a cleared or replaced session',
    async (stored) => {
      await expect(
        fixture(stored).strategy.validate(request, payload),
      ).rejects.toMatchObject({ status: 401 });
    },
  );
  it('still rejects disabled accounts with a matching token', async () => {
    const { user, strategy } = fixture(token);
    user.isActive = false;
    await expect(strategy.validate(request, payload)).rejects.toMatchObject({
      status: 401,
    });
  });
});
