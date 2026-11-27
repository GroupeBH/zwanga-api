import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { JwtStrategy } from './jwt.strategy';
import { tokenFingerprint } from '../token-fingerprint';
import { UserStatus } from '../../users/entities/user.entity';
import { JwtService } from '@nestjs/jwt';

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
    const users = { findAuthIdentity: jest.fn().mockResolvedValue(user) };
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
  it('rejects a freshly forged token even when its signature verifies with the known signing key', async () => {
    const jwt = new JwtService({ secret: 'test-only-secret' });
    const forged = jwt.sign(
      { ...payload, role: 'super_admin' },
      { expiresIn: '1m' },
    );
    const verified = jwt.verify<typeof payload>(forged);
    const forgedRequest = {
      headers: { authorization: `Bearer ${forged}` },
    } as Request;
    await expect(
      fixture(tokenFingerprint(token)).strategy.validate(
        forgedRequest,
        verified,
      ),
    ).rejects.toMatchObject({ status: 401 });
  });
  it('uses the database role, not a privileged role claim, even for the stored session', async () => {
    const { strategy } = fixture(tokenFingerprint(token));
    await expect(
      strategy.validate(request, { ...payload, role: 'super_admin' }),
    ).resolves.toMatchObject({ role: 'passenger' });
  });
});
