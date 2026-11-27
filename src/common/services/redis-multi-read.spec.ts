import { RedisService } from './redis.service';

describe('bounded Redis multi-reads', () => {
  function fixture() {
    const client = { mGet: jest.fn(async (keys: string[]) => keys.map(key => key === 'missing' ? null : JSON.stringify(key))) };
    const service: RedisService = Object.assign(Object.create(RedisService.prototype), { client });
    return { service, client };
  }
  it('preserves order and missing entries, with at most 64 keys per command', async () => {
    const f = fixture(), keys = Array.from({ length: 129 }, (_, i) => String(i));
    keys[64] = 'missing';
    expect(await f.service.getMany(keys)).toEqual(keys.map(key => key === 'missing' ? null : key));
    expect(f.client.mGet.mock.calls.map(([batch]) => batch.length)).toEqual([64, 64, 1]);
  });
  it('makes no command for an empty batch', async () => {
    const f = fixture();
    expect(await f.service.getMany([])).toEqual([]);
    expect(f.client.mGet).not.toHaveBeenCalled();
  });
  it('does not turn malformed cache data into a valid snapshot', async () => {
    const f = fixture();
    f.client.mGet.mockResolvedValue(['not json']);
    await expect(f.service.getMany(['key'])).rejects.toThrow();
  });
});
