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
    socket: {
      tls: redisTls,
      connectTimeout: 5_000,
      reconnectStrategy: false,
    },
  };
}

export function redisOptionsUseTls(options: RedisClientOptions): boolean {
  return Boolean(
    options.socket && 'tls' in options.socket && options.socket.tls === true,
  );
}
