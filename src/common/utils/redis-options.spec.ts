import { ConfigService } from '@nestjs/config';
import {
  buildRedisClientOptions,
  connectRedisWithDeadline,
} from './redis-options';

describe('Redis recovery', () => {
  afterEach(() => jest.useRealTimers());
  it('retries with bounded backoff without queuing offline commands', () => {
    const options = buildRedisClientOptions(
      new ConfigService({ REDIS_URL: 'rediss://localhost:6379' }),
    );
    expect(options.disableOfflineQueue).toBe(true);
    expect(options.socket).toMatchObject({ tls: true, connectTimeout: 5000 });
    const retry = options.socket!.reconnectStrategy as (n: number) => number;
    for (const n of [0, 1, 10, 10000]) {
      expect(retry(n)).toBeGreaterThanOrEqual(100);
      expect(retry(n)).toBeLessThan(5100);
    }
  });
  it('cancels a startup that never becomes ready', async () => {
    jest.useFakeTimers();
    const client = {
      isOpen: true,
      connect: jest.fn(() => new Promise(() => undefined)),
      disconnect: jest.fn(async () => undefined),
    };
    const pending = expect(
      connectRedisWithDeadline(client, 50),
    ).rejects.toThrow('deadline');
    await jest.advanceTimersByTimeAsync(51);
    await pending;
    expect(client.disconnect).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });
  it('removes its startup timer after a successful connection', async () => {
    jest.useFakeTimers();
    const client = {
      isOpen: true,
      connect: jest.fn(async () => undefined),
      disconnect: jest.fn(),
    };
    await connectRedisWithDeadline(client);
    expect(client.disconnect).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });
});
