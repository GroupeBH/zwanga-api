import { IpThrottlerGuard } from './throttler.guard';

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

  it('uses the forwarded IP for public requests', async () => {
    await expect(
      guard.tracker({
        headers: { 'x-forwarded-for': '203.0.113.10, 10.0.0.1' },
        ip: '10.0.0.1',
      }),
    ).resolves.toBe('ip:203.0.113.10');
  });

  it('falls back to the request IP', async () => {
    await expect(
      guard.tracker({ headers: {}, ip: '198.51.100.8' }),
    ).resolves.toBe('ip:198.51.100.8');
  });
});
