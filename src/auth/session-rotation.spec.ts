import { AuthService } from './auth.service';
import { matchesStoredToken, tokenFingerprint } from './token-fingerprint';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe('atomic refresh rotation', () => {
  function setup(storedRefresh = tokenFingerprint('old-refresh')) {
    const row = { id: 'synthetic', phone: 'synthetic', role: 'passenger', status: 'active',
      isActive: true, refreshToken: storedRefresh as string | null, accessToken: 'old-access' as string | null };
    const started = deferred(), resume = deferred();
    const service = Object.create(AuthService.prototype);
    const update = jest.fn(async (where, values) => {
      if (typeof where === 'object' && !Object.entries(where).every(([key, value]) => row[key] === value)) {
        return { affected: 0 };
      }
      Object.assign(row, values);
      return { affected: 1 };
    });
    let count = 0;
    Object.assign(service, {
      logger: { log: jest.fn() }, configService: { get: () => undefined },
      userRepository: { findOne: jest.fn(async () => ({ ...row })), update },
      jwtService: { verifyAsync: jest.fn(async () => ({ sub: row.id })), signAsync: jest.fn(async () => {
        started.resolve(); await resume.promise; return `synthetic-token-${++count}`;
      }) },
    });
    return { service, row, started, resume, update };
  }

  it.each(['plain', 'fingerprint'])('preserves and rotates existing %s sessions', async kind => {
    const test = setup(kind === 'plain' ? 'old-refresh' : undefined);
    test.resume.resolve();
    const result = await test.service.refreshToken({ refreshToken: 'old-refresh' });
    expect(matchesStoredToken(test.row.accessToken, result.accessToken)).toBe(true);
    expect(matchesStoredToken(test.row.refreshToken, result.refreshToken)).toBe(true);
    await expect(test.service.refreshToken({ refreshToken: 'old-refresh' })).rejects.toMatchObject({ status: 401 });
  });

  it.each(['logout', 'pin_reset', 'suspend', 'deactivate', 'role_change'])('does not undo concurrent %s', async action => {
    const test = setup();
    const refreshing = test.service.refreshToken({ refreshToken: 'old-refresh' });
    const rejected = expect(refreshing).rejects.toMatchObject({ status: 401 });
    await test.started.promise;
    if (action === 'logout') await test.service.logout(test.row.id);
    else if (action === 'pin_reset') await test.update(test.row.id, { accessToken: null, refreshToken: null });
    else if (action === 'suspend') test.row.status = 'suspended';
    else if (action === 'deactivate') test.row.isActive = false;
    else test.row.role = 'driver';
    const expected = { ...test.row };
    test.resume.resolve();
    await rejected;
    expect(test.row).toEqual(expected);
  });

  it('allows only one concurrent rotation of the same proof', async () => {
    const test = setup();
    const results = Promise.allSettled([
      test.service.refreshToken({ refreshToken: 'old-refresh' }),
      test.service.refreshToken({ refreshToken: 'old-refresh' }),
    ]);
    await test.started.promise;
    test.resume.resolve();
    const settled = await results;
    expect(settled.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(settled.filter(result => result.status === 'rejected')).toHaveLength(1);
  });
});
