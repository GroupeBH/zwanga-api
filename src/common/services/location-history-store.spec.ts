import { appendLocationHistory } from './location-history-store';
import type { TrackedLocationPoint } from './location-history.service';

describe('cached atomic Redis history command', () => {
  const current: TrackedLocationPoint = { latitude: -4.3, longitude: 15.3,
    recordedAt: '2026-11-22T19:00:00.000Z', accuracyMeters: 5, speedMetersPerSecond: null, headingDegrees: null };
  const fixture = () => ({ evalSha: jest.fn().mockResolvedValue(1), eval: jest.fn().mockResolvedValue(1) });
  it('sends one key, a bounded payload and the original six-hour TTL', async () => {
    const client = fixture();
    await appendLocationHistory(client as any, 'tracking:history:driver:trip', current, Array(20).fill(current), true, 21600);
    expect(client.evalSha).toHaveBeenCalledTimes(1);
    const [sha, options] = client.evalSha.mock.calls[0];
    expect(sha).toMatch(/^[a-f0-9]{40}$/);
    expect(options.keys).toEqual(['tracking:history:driver:trip']);
    expect(JSON.parse(options.arguments[1])).toHaveLength(10);
    expect(options.arguments.slice(2)).toEqual(['1', '21600']);
    expect(client.eval).not.toHaveBeenCalled();
  });
  it('reloads only a missing server-side script, including after Redis failover', async () => {
    const client = fixture();
    client.evalSha.mockRejectedValueOnce(new Error('NOSCRIPT No matching script. Please use EVAL.'));
    await appendLocationHistory(client as any, 'key', current, [], false, 21600);
    expect(client.eval).toHaveBeenCalledTimes(1);
    expect(client.eval.mock.calls[0][1]).toEqual(client.evalSha.mock.calls[0][1]);
  });
  it.each(['Redis command deadline', 'Socket closed unexpectedly', 'OOM command not allowed', 'NOPERM', 'ERR invalid JSON'])(
    'does not replay an ambiguous or forbidden command: %s', async message => {
      const client = fixture();
      client.evalSha.mockRejectedValueOnce(new Error(message));
      await expect(appendLocationHistory(client as any, 'key', current, [], false, 21600)).rejects.toThrow(message);
      expect(client.evalSha).toHaveBeenCalledTimes(1);
      expect(client.eval).not.toHaveBeenCalled();
    });
});
