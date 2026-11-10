import { RequestDriverQueue, REQUEST_CANDIDATE_CACHE_SECONDS } from './request-driver-queue';
import { REQUEST_RESPONSE_MS } from './sequential-policy';

describe('request candidate cache lifetime', () => {
  it('survives delivery plus one complete response window without extending invitations', async () => {
    expect(REQUEST_CANDIDATE_CACHE_SECONDS * 1000).toBeGreaterThan(REQUEST_RESPONSE_MS * 2);
    expect(REQUEST_CANDIDATE_CACHE_SECONDS).toBeLessThanOrEqual(120);
    const evalScript = jest.fn().mockResolvedValue(1);
    const queue = new RequestDriverQueue({ getClient: () => ({ eval: evalScript }) } as any);
    expect(await queue.seed('request', 'lease', 'version', ['driver-a', 'driver-b'])).toBe(true);
    const [script, args] = evalScript.mock.calls[0];
    expect(script).toContain(`'EXPIRE', KEYS[2], ${REQUEST_CANDIDATE_CACHE_SECONDS}`);
    expect(script).toContain(`'EX', ${REQUEST_CANDIDATE_CACHE_SECONDS}`);
    expect(args.keys.every((key: string) => key.startsWith('ride-requests:{request}:'))).toBe(true);
    expect(script).toContain("redis.call('GET', KEYS[1]) ~= ARGV[1]");
  });
});
