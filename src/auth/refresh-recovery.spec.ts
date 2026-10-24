import { AuthService } from './auth.service';
import { tokenFingerprint } from './token-fingerprint';
import { openRefreshReceipt, sealRefreshReceipt } from './refresh-recovery';

describe('bounded refresh response recovery', () => {
  const requestId = '22222222-2222-4222-8222-222222222222';
  function fixture() {
    const row = {
      id: 'synthetic-user',
      role: 'passenger',
      status: 'active',
      isActive: true,
      refreshToken: tokenFingerprint('old-refresh'),
      accessToken: tokenFingerprint('old-access'),
    };
    const entries = new Map<string, string>();
    const redis = {
      get: jest.fn(async (key) => entries.get(key) ?? null),
      compareAndSet: jest.fn(async (key, _expected, value) => {
        if (entries.has(key)) return false;
        entries.set(key, value);
        return true;
      }),
    };
    const update = jest.fn(async (where, patch) => {
      if (!Object.entries(where).every(([key, value]) => row[key] === value))
        return { affected: 0 };
      Object.assign(row, patch);
      return { affected: 1 };
    });
    const service = Object.create(AuthService.prototype);
    Object.assign(service, {
      redisService: redis,
      configService: { get: () => 'synthetic-test-secret' },
      jwtService: { verifyAsync: async () => ({ sub: row.id }) },
      userRepository: { findOne: jest.fn(async () => ({ ...row })), update },
      signTokens: jest.fn(async () => ({
        accessToken: 'new-access',
        refreshToken: 'new-refresh',
      })),
    });
    const refresh = () =>
      service.refreshToken({ refreshToken: 'old-refresh', requestId });
    return { row, redis, entries, update, service, refresh };
  }
  it('replays the same response after a lost reply, without a second rotation', async () => {
    const f = fixture();
    const first = await f.refresh();
    expect(await f.refresh()).toEqual(first);
    expect(f.update).toHaveBeenCalledTimes(1);
    expect(f.service.signTokens).toHaveBeenCalledTimes(1);
    expect([...f.entries.values()].join()).not.toContain('new-refresh');
    expect(f.redis.compareAndSet.mock.calls[0][3]).toBe(120);
  });
  it('returns the same pair to concurrent retries of the same attempt', async () => {
    const f = fixture();
    expect(await Promise.all([f.refresh(), f.refresh()])).toEqual([
      { accessToken: 'new-access', refreshToken: 'new-refresh' },
      { accessToken: 'new-access', refreshToken: 'new-refresh' },
    ]);
  });
  it.each([
    'logout',
    'pin_reset',
    'suspend',
    'deactivate',
    'role_change',
    'new_login',
  ])('a receipt cannot undo %s', async (action) => {
    const f = fixture();
    await f.refresh();
    if (action === 'logout' || action === 'pin_reset')
      Object.assign(f.row, { accessToken: null, refreshToken: null });
    if (action === 'suspend') f.row.status = 'suspended';
    if (action === 'deactivate') f.row.isActive = false;
    if (action === 'role_change') f.row.role = 'driver';
    if (action === 'new_login')
      f.row.refreshToken = tokenFingerprint('another-session');
    await expect(f.refresh()).rejects.toMatchObject({ status: 401 });
    expect(f.update).toHaveBeenCalledTimes(1);
  });
  it('does not accept a different attempt ID or a legacy replay', async () => {
    const f = fixture();
    await f.refresh();
    await expect(
      f.service.refreshToken({
        refreshToken: 'old-refresh',
        requestId: 'different',
      }),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      f.service.refreshToken({ refreshToken: 'old-refresh' }),
    ).rejects.toMatchObject({ status: 401 });
  });
  it('cannot rotate if the recovery receipt could not be saved', async () => {
    const f = fixture();
    f.redis.compareAndSet.mockRejectedValueOnce(new Error('cache unavailable'));
    await expect(f.refresh()).rejects.toMatchObject({ status: 503 });
    expect(f.update).not.toHaveBeenCalled();
    expect(f.row.refreshToken).toBe(tokenFingerprint('old-refresh'));
  });
  it('refuses an expired receipt even if Redis eviction is late', async () => {
    const f = fixture();
    await f.refresh();
    const [key, sealed] = [...f.entries][0];
    const value = openRefreshReceipt<any>(sealed, 'synthetic-test-secret');
    value.expiresAt = Date.now() - 1;
    f.entries.set(key, sealRefreshReceipt(value, 'synthetic-test-secret'));
    await expect(f.refresh()).rejects.toMatchObject({ status: 401 });
  });
  it('authenticates the encrypted receipt', () => {
    const sealed = sealRefreshReceipt({ token: 'synthetic' }, 'one');
    expect(() => openRefreshReceipt(sealed, 'two')).toThrow();
  });
});
