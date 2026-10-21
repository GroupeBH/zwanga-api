import { HealthController } from './health.controller';
import { Reflector } from '@nestjs/core';
import { IpThrottlerGuard } from '../common/guards/throttler.guard';

describe('deployment readiness', () => {
  it('liveness bypasses the Redis rate limiter, but readiness keeps its limits', async () => {
    const storage = { increment: jest.fn().mockRejectedValue(new Error('Redis unavailable')) };
    const guard = new IpThrottlerGuard([{ ttl: 60000, limit: 10 }], storage as any, new Reflector());
    await guard.onModuleInit();
    const context = { getType: () => 'http', getHandler: () => HealthController.prototype.live, getClass: () => HealthController };
    expect(await guard.canActivate(context as any)).toBe(true);
    expect(storage.increment).not.toHaveBeenCalled();
    expect(Reflect.getMetadata('THROTTLER:SKIPdefault', HealthController.prototype.check)).not.toBe(true);
  });
  it('reports liveness without touching external dependencies', () => {
    const service = new HealthController(undefined as any, undefined as any, undefined as any, undefined as any);
    expect(service.live()).toMatchObject({ status: 'ok' });
  });
  const fixture = (schema: any) => {
    const query = jest
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce([schema]);
    const source = { transaction: (work: any) => work({ query }) };
    const service = new HealthController(
      { check: jest.fn().mockResolvedValue({}) } as any,
      {} as any,
      {} as any,
      source as any,
    );
    return { service, query };
  };
  it.each([false, true])(
    'is ready for prepared/active schema (enabled=%s)',
    async (enabled) => {
      const { service, query } = fixture({
        contractVersion: 1,
        enabled,
        functions: true,
        recovery: true,
        referrals: true,
      });
      expect(await service.check()).toMatchObject({ status: 'ok' });
      expect(query).toHaveBeenCalledWith(
        "SET LOCAL statement_timeout = '1500ms'",
      );
    },
  );
  it.each([
    undefined,
    { contractVersion: 0, functions: true },
    { contractVersion: 1, functions: false },
    { contractVersion: 1, functions: true, recovery: false },
    { contractVersion: 1, functions: true, recovery: true, referrals: false },
  ])('refuses traffic with an incompatible/missing schema', async (schema) => {
    await expect(fixture(schema).service.check()).rejects.toMatchObject({
      status: 503,
    });
  });
});
