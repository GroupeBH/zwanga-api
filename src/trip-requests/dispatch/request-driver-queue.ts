import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { RedisService } from '../../common/services/redis.service';

export const REQUEST_DEADLINES_KEY = 'ride-requests:deadlines';
const key = (id: string) => 'ride-requests:{' + id + '}';

/** Redis owns the ordered candidate queue and scheduling. SQL fences/reserves
 * invitations and persists the outbox. Never store names, phones or coordinates here. */
@Injectable()
export class RequestDriverQueue {
  constructor(private readonly redis: RedisService) {}
  /** Acquire and read a bounded window in one round trip, without destructive popping.
   * A crash/SQL rollback leaves the same driver at the head for the next worker. */
  async claim(id: string, version: string): Promise<{ token: string; drivers: string[] } | null> {
    const token = randomUUID();
    const rows = await this.redis.getClient().eval(`
      if not redis.call('SET', KEYS[1], ARGV[1], 'NX', 'PX', 10000) then return false end
      if redis.call('GET', KEYS[3]) ~= ARGV[2] then redis.call('DEL', KEYS[2], KEYS[3]) end
      return redis.call('LRANGE', KEYS[2], 0, 49)`, {
      keys: [key(id) + ':lock', key(id) + ':waiting', key(id) + ':version'], arguments: [token, version],
    });
    return Array.isArray(rows) ? { token, drivers: rows.map(String) } : null;
  }
  async seed(id: string, token: string, version: string, drivers: string[]): Promise<boolean> {
    return Number(await this.redis.getClient().eval(`
      if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
      redis.call('DEL', KEYS[2])
      for i = 3, #ARGV do redis.call('RPUSH', KEYS[2], ARGV[i]) end
      redis.call('EXPIRE', KEYS[2], 60)
      redis.call('SET', KEYS[3], ARGV[2], 'EX', 60)
      redis.call('PEXPIRE', KEYS[1], 10000)
      return 1`, { keys: [key(id) + ':lock', key(id) + ':waiting', key(id) + ':version'],
      arguments: [token, version, ...drivers] })) === 1;
  }
  /** Acknowledge only after SQL commit. Ownership fences an expired/replaced lease. */
  async release(id: string, token: string, selectedDriverId?: string, reset = false) {
    await this.redis.getClient().eval(`
      if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
      if ARGV[3] == '1' then redis.call('DEL', KEYS[2], KEYS[3])
      elseif ARGV[2] ~= '' then
        local index = redis.call('LPOS', KEYS[2], ARGV[2])
        if index then redis.call('LTRIM', KEYS[2], index + 1, -1) end
      end
      return redis.call('DEL', KEYS[1])`, {
      keys: [key(id) + ':lock', key(id) + ':waiting', key(id) + ':version'],
      arguments: [token, selectedDriverId ?? '', reset ? '1' : '0'],
    });
  }
  async lock(id: string): Promise<string | null> {
    const token = randomUUID();
    return await this.redis.getClient().set(key(id) + ':lock', token, { NX: true, PX: 10_000 }) ? token : null;
  }
  async unlock(id: string, token: string) {
    await this.redis.getClient().eval(`if redis.call('GET', KEYS[1]) == ARGV[1] then
      return redis.call('DEL', KEYS[1]) end return 0`, { keys: [key(id) + ':lock'], arguments: [token] });
  }
  async replace(id: string, token: string, drivers: string[], ttlSeconds: number): Promise<boolean> {
    return Number(await this.redis.getClient().eval(`
      if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
      redis.call('DEL', KEYS[2])
      for i = 3, #ARGV do redis.call('RPUSH', KEYS[2], ARGV[i]) end
      if #ARGV > 2 then redis.call('EXPIRE', KEYS[2], ARGV[2]) end
      return 1`, { keys: [key(id) + ':lock', key(id) + ':waiting'],
        arguments: [token, String(Math.max(60, Math.min(86400, ttlSeconds))), ...drivers] })) === 1;
  }
  async take(id: string, token: string): Promise<string | null> {
    const result = await this.redis.getClient().eval(`
      if redis.call('GET', KEYS[1]) ~= ARGV[1] then return false end
      return redis.call('LPOP', KEYS[2])`, { keys: [key(id) + ':lock', key(id) + ':waiting'], arguments: [token] });
    return typeof result === 'string' ? result : null;
  }
  async isDue(id: string) {
    const deadline = await this.redis.getClient().zScore(REQUEST_DEADLINES_KEY, id);
    return deadline === null || deadline <= Date.now();
  }
  async schedule(id: string, at: number) { await this.redis.getClient().zAdd(REQUEST_DEADLINES_KEY, { score: at, value: id }); }
  async due(now: number) { return this.redis.getClient().zRangeByScore(REQUEST_DEADLINES_KEY, 0, now, { LIMIT: { offset: 0, count: 50 } }); }
  async close(id: string) {
    await this.redis.getClient().del([key(id) + ':waiting', key(id) + ':version']);
    await this.redis.getClient().zRem(REQUEST_DEADLINES_KEY, id);
  }
}
