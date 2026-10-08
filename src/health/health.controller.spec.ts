import { HealthController } from './health.controller';

describe('deployment readiness', () => {
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
  ])('refuses traffic with an incompatible/missing schema', async (schema) => {
    await expect(fixture(schema).service.check()).rejects.toMatchObject({
      status: 503,
    });
  });
});
