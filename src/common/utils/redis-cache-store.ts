import type {
  CacheStore,
  CacheStoreSetOptions,
} from '@nestjs/cache-manager';
import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { createClient } from 'redis';
import type { Store } from 'cache-manager';
import { buildRedisClientOptions, redisOptionsUseTls } from './redis-options';

type RedisClient = ReturnType<typeof createClient>;

const DEFAULT_CACHE_TTL_SECONDS = 300;

function resolveTtlSeconds<T>(
  options?: CacheStoreSetOptions<T> | number,
): number | undefined {
  if (typeof options === 'number') {
    return Math.max(Math.floor(options), 0);
  }

  if (!options || options.ttl === undefined) {
    return DEFAULT_CACHE_TTL_SECONDS;
  }

  if (typeof options.ttl === 'function') {
    return undefined;
  }

  return Math.max(Math.floor(options.ttl), 0);
}

export async function createRedisCacheStore(
  configService: ConfigService,
): Promise<CacheStore & Store> {
  const logger = new Logger('RedisCacheStore');
  const redisOptions = buildRedisClientOptions(configService);
  const client: RedisClient = createClient(redisOptions);

  client.on('error', (error) => {
    logger.error(`Redis cache client error: ${error.message}`);
  });

  await client.connect();
  logger.log(
    `Redis cache connected${redisOptionsUseTls(redisOptions) ? ' with TLS' : ''}`,
  );

  return {
    async get<T>(key: string): Promise<T | undefined> {
      const value = await client.get(key);
      if (value === null) {
        return undefined;
      }

      return JSON.parse(value) as T;
    },

    async set<T>(
      key: string,
      value: T,
      options?: CacheStoreSetOptions<T> | number,
    ): Promise<void> {
      const serialized = JSON.stringify(value);
      const ttlSeconds = resolveTtlSeconds(options);

      if (ttlSeconds === undefined) {
        await client.set(key, serialized);
        return;
      }

      if (ttlSeconds <= 0) {
        await client.del(key);
        return;
      }

      await client.setEx(key, ttlSeconds, serialized);
    },

    async del(key: string): Promise<void> {
      await client.del(key);
    },

    async reset(): Promise<void> {
      await client.flushDb();
    },

    async mset(entries: Array<[string, unknown]>, ttl?: number): Promise<void> {
      await Promise.all(
        entries.map(([key, value]) => this.set(key, value, ttl)),
      );
    },

    async mget(...keys: string[]): Promise<unknown[]> {
      const values = await client.mGet(keys);
      return values.map((value) =>
        value === null ? undefined : JSON.parse(value),
      );
    },

    async mdel(...keys: string[]): Promise<void> {
      if (keys.length > 0) {
        await client.del(keys);
      }
    },

    async keys(pattern = '*'): Promise<string[]> {
      return client.keys(pattern);
    },

    async ttl(key: string): Promise<number> {
      return client.ttl(key);
    },
  };
}
