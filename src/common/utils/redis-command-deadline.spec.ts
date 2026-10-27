import { withRedisCommandDeadlines } from './redis-command-deadline';

describe('Redis command deadlines', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());
  it.each(['eval', 'zScore', 'zAdd', 'zRangeByScore', 'zRem'])('bounds stalled %s without retrying it', async command => {
    const client = { [command]: jest.fn(() => new Promise(() => undefined)) };
    const recover = jest.fn();
    const wrapped = withRedisCommandDeadlines(client, 2000, recover);
    const rejected = expect(wrapped[command]()).rejects.toThrow('deadline');
    await jest.advanceTimersByTimeAsync(2001);
    await rejected;
    expect(client[command]).toHaveBeenCalledTimes(1);
    expect(recover).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });
  it('binds lifecycle and command methods to the raw client and clears timers', async () => {
    const client = {
      prefix: 'test',
      async get() {
        return this.prefix;
      },
      on() {
        return this;
      },
    };
    const recover = jest.fn();
    const wrapped = withRedisCommandDeadlines(client, 2000, recover);
    expect(wrapped.on()).toBe(client);
    expect(await wrapped.get()).toBe('test');
    expect(wrapped.get).toBe(wrapped.get);
    expect(recover).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });
  it('propagates command errors without recovery or fail-open results', async () => {
    const recover = jest.fn();
    const wrapped = withRedisCommandDeadlines(
      {
        get: async () => {
          throw new Error('offline');
        },
      },
      2000,
      recover,
    );
    await expect(wrapped.get()).rejects.toThrow('offline');
    expect(recover).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });
});
