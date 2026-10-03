import { ServiceUnavailableException } from '@nestjs/common';
import { ThrottlerStorage } from '@nestjs/throttler';
import { RedisService } from './redis.service';

export class RedisThrottlerStorage implements ThrottlerStorage {
  constructor(private readonly redis: RedisService) {}
  async increment(key: string, ttl: number) {
    try {
      const [totalHits, remainingMs] = await this.redis.getClient().eval(`
        local count = redis.call('INCR', KEYS[1])
        if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
        return {count, redis.call('PTTL', KEYS[1])}
      `, { keys: [`throttle:v2:${key}`], arguments: [String(Math.max(1000, ttl))] }) as number[];
      return { totalHits, timeToExpire: Math.max(1, Math.ceil(remainingMs / 1000)) };
    } catch {
      throw new ServiceUnavailableException('Service temporairement indisponible. Réessayez dans un instant.');
    }
  }
}
