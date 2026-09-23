import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HealthCheckError, HealthIndicatorService } from '@nestjs/terminus';
import { createClient } from 'redis';
import { buildRedisClientOptions } from '../common/utils/redis-options';

@Injectable()
export class RedisHealthIndicator {
  constructor(
    private readonly configService: ConfigService,
    private readonly healthIndicatorService: HealthIndicatorService,
  ) {}

  async pingCheck(key: string, timeout = 1_500) {
    const check = this.healthIndicatorService.check(key);
    const client = createClient(buildRedisClientOptions(this.configService));
    let timeoutRef: NodeJS.Timeout | undefined;

    try {
      const ping = (async () => {
        await client.connect();
        return client.ping();
      })();
      const result = await Promise.race([
        ping,
        new Promise<never>((_, reject) => {
          timeoutRef = setTimeout(
            () => reject(new Error(`timeout of ${timeout}ms exceeded`)),
            timeout,
          );
        }),
      ]);

      if (result !== 'PONG') {
        throw new Error(`unexpected Redis PING response: ${result}`);
      }

      return check.up();
    } catch (error) {
      throw new HealthCheckError('Redis health check failed', {
        [key]: check.down(
          error instanceof Error ? error.message : 'Redis ping failed',
        )[key],
      });
    } finally {
      if (timeoutRef) {
        clearTimeout(timeoutRef);
      }
      if (client.isOpen) {
        await client.quit().catch(() => client.disconnect());
      }
    }
  }
}
