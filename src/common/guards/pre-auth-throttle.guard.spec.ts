import { ConfigService } from '@nestjs/config';
import { PreAuthThrottleGuard } from './pre-auth-throttle.guard';

describe('pre-authentication IP budget', () => {
  function fixture(
    values: Record<string, unknown> = { PRE_AUTH_IP_LIMIT_PER_MINUTE: 1200 },
  ) {
    const evalMock = jest.fn().mockResolvedValue([1, 59999]);
    const reflector = { getAllAndOverride: jest.fn().mockReturnValue(false) };
    const guard = new PreAuthThrottleGuard(
      new ConfigService(values),
      { getClient: () => ({ eval: evalMock }) } as any,
      reflector as any,
    );
    const req = {
      ip: '198.51.100.1',
      user: { userId: 'ignored' },
      headers: { 'x-forwarded-for': 'forged' },
    };
    const res = { setHeader: jest.fn() };
    const context = {
      getType: () => 'http',
      getHandler: () => 'handler',
      getClass: () => 'controller',
      switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
    } as any;
    return { guard, evalMock, reflector, req, res, context };
  }
  it('rejects traffic before SQL once the IP budget is exhausted', async () => {
    const f = fixture();
    f.evalMock.mockResolvedValue([1201, 30000]);
    await expect(f.guard.canActivate(f.context)).rejects.toThrow(
      'ThrottlerException',
    );
    expect(f.res.setHeader).toHaveBeenCalledWith('Retry-After', '30');
  });
  it('shares the budget across account and route names without trusting XFF', async () => {
    const f = fixture();
    await f.guard.canActivate(f.context);
    f.req.user.userId = 'another';
    f.req.headers['x-forwarded-for'] = 'other';
    await f.guard.canActivate(f.context);
    expect(f.evalMock.mock.calls[0][1].keys).toEqual(
      f.evalMock.mock.calls[1][1].keys,
    );
  });
  it('keeps liveness and public provider callbacks unaffected', async () => {
    const f = fixture();
    f.reflector.getAllAndOverride.mockReturnValue(true);
    expect(await f.guard.canActivate(f.context)).toBe(true);
    expect(f.evalMock).not.toHaveBeenCalled();
  });
  it('does not aggregate production users behind an unconfigured ALB', () => {
    expect(() =>
      fixture({ NODE_ENV: 'production', PRE_AUTH_IP_LIMIT_PER_MINUTE: 1200 }),
    ).toThrow('TRUSTED_PROXY_CIDRS');
  });
  it('fails closed on Redis failure', async () => {
    const f = fixture();
    f.evalMock.mockRejectedValue(new Error('offline'));
    await expect(f.guard.canActivate(f.context)).rejects.toThrow(
      'indisponible',
    );
  });
});
