import { ConfigService } from '@nestjs/config';
import type { RedisClientOptions } from 'redis';

export function isConfigFlagEnabled(value?: string): boolean {
  return ['1', 'true', 'yes', 'y'].includes((value || '').toLowerCase());
}

export function buildRedisUrl(configService: ConfigService): string {
  const redisUrl = configService.get<string>('REDIS_URL')?.trim();
  if (redisUrl) {
    return redisUrl;
  }

  const host = configService.get<string>('REDIS_HOST')?.trim();
  if (!host) {
    throw new Error('REDIS_URL or REDIS_HOST must be configured');
  }

  const port = configService.get<string>('REDIS_PORT')?.trim() || '6379';
  const password = configService.get<string>('REDIS_PASSWORD')?.trim();
  const protocol = isConfigFlagEnabled(configService.get<string>('REDIS_TLS'))
    ? 'rediss'
    : 'redis';
  const auth = password ? `:${encodeURIComponent(password)}@` : '';

  return `${protocol}://${auth}${host}:${port}`;
}

export function buildRedisClientOptions(
  configService: ConfigService,
): RedisClientOptions {
  const redisUrl = buildRedisUrl(configService);
  const redisTls =
    isConfigFlagEnabled(configService.get<string>('REDIS_TLS')) ||
    redisUrl.startsWith('rediss://');

  return {
    url: redisUrl,
    disableOfflineQueue: true,
    commandsQueueMaxLength: 1000,
    socket: {
      tls: redisTls,
      connectTimeout: 5_000,
      // Recover from a Valkey failover without building an offline request queue.
      reconnectStrategy: (retries) =>
        Math.min(100 * 2 ** Math.min(retries, 6), 5_000) + Math.floor(Math.random() * 100),
    },
  };
}

type ConnectableRedisClient = {
  isOpen: boolean;
  connect(): Promise<unknown>;
  disconnect(): Promise<unknown>;
};

/** Runtime retries are unbounded, but an unavailable dependency must not hang boot. */
export async function connectRedisWithDeadline(
  client: ConnectableRedisClient,
  timeoutMs = 10_000,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      client.connect(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Redis connection deadline exceeded')), timeoutMs);
      }),
    ]);
  } catch (error) {
    if (client.isOpen) await client.disconnect().catch(() => undefined);
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function redisOptionsUseTls(options: RedisClientOptions): boolean {
  return Boolean(
    options.socket && 'tls' in options.socket && options.socket.tls === true,
  );
}
