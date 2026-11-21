import { createClient } from 'redis';
import { createRedisCacheStore } from './utils/redis-cache-store';
import { rememberRoutePreview } from './route-preview';
jest.mock('redis', () => ({ createClient: jest.fn() }));
jest.mock('./utils/redis-options', () => ({
  buildRedisClientOptions: () => ({}),
  connectRedisWithDeadline: async () => {},
  redisOptionsUseTls: () => false,
}));

it('route preview uses the actual Redis adapter EX seconds: one day, not 1000 days', async () => {
  const setEx = jest.fn().mockResolvedValue('OK');
  jest.mocked(createClient).mockReturnValue({ on: jest.fn(), setEx } as any);
  const store = await createRedisCacheStore({} as any);
  await rememberRoutePreview(
    store as any,
    { origin: { lat: -4.3, lng: 15.3 }, destination: { lat: -4.4, lng: 15.4 } },
    { routes: [{ legs: [{ duration: 600 }] }] } as any,
  );
  expect(setEx).toHaveBeenCalledWith(
    expect.any(String),
    86400,
    expect.any(String),
  );
});
