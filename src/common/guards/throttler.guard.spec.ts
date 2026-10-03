import { IpThrottlerGuard } from './throttler.guard';
import { RedisThrottlerStorage } from '../services/redis-throttler.storage';
import { ThrottlerGuard } from '@nestjs/throttler';

class TestableIpThrottlerGuard extends IpThrottlerGuard {
  tracker(request: Record<string, any>): Promise<string> {
    return this.getTracker(request);
  }
}

describe('IpThrottlerGuard', () => {
  const guard = Object.create(
    TestableIpThrottlerGuard.prototype,
  ) as TestableIpThrottlerGuard;

  it('uses the authenticated user instead of a shared IP address', async () => {
    await expect(
      guard.tracker({
        user: { userId: 'user-123' },
        headers: { 'x-forwarded-for': '203.0.113.10' },
        ip: '10.0.0.1',
      }),
    ).resolves.toBe('user:user-123');
  });

  it('ignores spoofed forwarded headers for public requests', async () => {
    await expect(
      guard.tracker({
        headers: { 'x-forwarded-for': '203.0.113.10, 10.0.0.1' },
        ip: '10.0.0.1',
      }),
    ).resolves.toBe('ip:10.0.0.1');
  });

  it('falls back to the request IP', async () => {
    await expect(
      guard.tracker({ headers: {}, ip: '198.51.100.8' }),
    ).resolves.toBe('ip:198.51.100.8');
  });
});

describe('Distributed rate limits', () => {
  it('uses atomic Redis counters and converts millisecond TTL to Retry-After seconds', async () => {
    const evalMock = jest.fn().mockResolvedValue([5, 59999]);
    const storage = new RedisThrottlerStorage({ getClient: () => ({ eval: evalMock }) } as any);
    expect(await storage.increment('test-key', 60000)).toEqual({ totalHits: 5, timeToExpire: 60 });
    expect(evalMock.mock.calls[0][0]).toContain("'PEXPIRE'");
    expect(evalMock.mock.calls[0][1].arguments).toEqual(['60000']);
    evalMock.mockRejectedValue(new Error('offline'));
    await expect(storage.increment('test-key', 60000)).rejects.toThrow('indisponible');
  });
  it('shares the login account key across different IPs and login endpoints', async () => {
    const permitIp = jest.spyOn(ThrottlerGuard.prototype, 'canActivate').mockResolvedValue(true);
    const increment = jest.fn().mockResolvedValue({ totalHits: 1, timeToExpire: 60 });
    const guard = new IpThrottlerGuard([], { increment }, { getAllAndOverride: () => true } as any);
    const res = { header: jest.fn() };
    const context = (ip: string, method: string) => ({ getType: () => 'http', getHandler: () => method,
      getClass: () => 'AuthController', switchToHttp: () => ({ getRequest: () => ({ ip, body: { phone: '+243000000000' } }), getResponse: () => res }) }) as any;
    try {
      await guard.canActivate(context('192.0.2.1', 'login'));
      await guard.canActivate(context('192.0.2.2', 'adminLogin'));
      expect(increment.mock.calls[0][0]).toBe(increment.mock.calls[2][0]);
      increment.mockResolvedValue({ totalHits: 21, timeToExpire: 300 });
      await expect(guard.canActivate(context('192.0.2.3', 'login'))).rejects.toThrow('tentatives');
      expect(res.header).toHaveBeenCalledWith('Retry-After', 300);
    } finally { permitIp.mockRestore(); }
  });
});
