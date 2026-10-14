import { AuthService } from './auth.service';

describe('Apple public key retrieval', () => {
  const originalFetch = global.fetch;
  let service: any;
  beforeEach(() => {
    jest.useFakeTimers();
    service = Object.create(AuthService.prototype);
    Object.assign(service, {
      applePublicKeys: [],
      applePublicKeysExpiresAt: 0,
      logger: { error: jest.fn() },
    });
  });
  afterEach(() => {
    global.fetch = originalFetch;
    jest.useRealTimers();
  });
  it('shares one fetch across simultaneous logins and then serves its cache', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue({
        ok: true,
        json: async () => ({ keys: [{ kid: 'test' }] }),
      });
    const results = await Promise.all([
      service.getApplePublicKeys(),
      service.getApplePublicKeys(),
    ]);
    expect(results).toEqual([[{ kid: 'test' }], [{ kid: 'test' }]]);
    await service.getApplePublicKeys();
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });
  it.each(['headers', 'body'])(
    'times out stalled %s with a retryable 503 for all waiters',
    async (stage) => {
      global.fetch = jest
        .fn()
        .mockImplementation(() =>
          stage === 'headers'
            ? new Promise(() => undefined)
            : Promise.resolve({
                ok: true,
                json: () => new Promise(() => undefined),
              }),
        );
      const one = expect(service.getApplePublicKeys()).rejects.toMatchObject({
        status: 503,
      });
      const two = expect(service.getApplePublicKeys()).rejects.toMatchObject({
        status: 503,
      });
      await jest.advanceTimersByTimeAsync(5001);
      await Promise.all([one, two]);
      const options = (global.fetch as jest.Mock).mock.calls[0][1];
      expect(options.signal.aborted).toBe(true);
      expect(service.applePublicKeysRequest).toBeUndefined();
      expect(service.applePublicKeys).toEqual([]);
      expect(jest.getTimerCount()).toBe(0);
    },
  );
});
