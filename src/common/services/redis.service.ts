import { createClient } from 'redis';
import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { withRedisCommandDeadlines } from '../utils/redis-command-deadline';
import {
  buildRedisClientOptions,
  connectRedisWithDeadline,
  redisOptionsUseTls,
} from '../utils/redis-options';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private client: ReturnType<typeof createClient>;
  private stopping = false;
  private reconnecting = false;

  constructor(private configService: ConfigService) {}

  async onModuleInit() {
    const redisOptions = buildRedisClientOptions(this.configService);
    const timeoutMs = Number(this.configService.get<string>('REDIS_COMMAND_TIMEOUT_MS') ?? 2000);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10000) {
      throw new Error('REDIS_COMMAND_TIMEOUT_MS must be between 100 and 10000');
    }
    this.client = withRedisCommandDeadlines(createClient(redisOptions), timeoutMs, () => this.reconnectAfterTimeout());

    this.client.on('error', (err) => {
      this.logger.error('Redis Client Error:', err);
    });
    this.client.on('connect', () => {
      this.logger.log('Redis Client Connected');
    });

    await connectRedisWithDeadline(this.client);
    this.logger.log(
      `Redis connected${redisOptionsUseTls(redisOptions) ? ' with TLS' : ''}`,
    );
  }

  async onModuleDestroy() {
    this.stopping = true;
    this.logger.log('Disconnecting Redis client');
    if (this.client?.isOpen) {
      await this.client.disconnect();
    }
    this.logger.log('Redis client disconnected');
  }

  getClient() {
    return this.client;
  }

  private reconnectAfterTimeout(): void {
    if (this.stopping || this.reconnecting) return;
    this.reconnecting = true;
    // Drop the stalled reply queue. Do not retry commands: a timed-out write
    // may already have reached Redis. New commands fail closed during recovery.
    void (async () => {
      if (this.client.isOpen) await this.client.disconnect();
      if (!this.stopping) await this.client.connect();
    })().catch(() => this.logger.warn('Redis command timeout: connection recovery failed'))
      .finally(() => { this.reconnecting = false; });
  }

  async get<T>(key: string): Promise<T | null> {
    const value = await this.client.get(key);
    return value ? JSON.parse(value) : null;
  }

  /** Read and delete in one Redis command: a one-time value cannot be replayed. */
  async consume<T>(key: string): Promise<T | null> {
    const value = await this.client.getDel(key);
    return value === null ? null : (JSON.parse(value) as T);
  }

  async set(key: string, value: any, ttl?: number): Promise<void> {
    const stringValue = JSON.stringify(value);
    if (ttl) {
      await this.client.setEx(key, ttl, stringValue);
    } else {
      await this.client.set(key, stringValue);
    }
  }

  async del(key: string): Promise<void> {
    await this.client.del(key);
  }

  /** Compare the entire snapshot atomically; never overwrite a concurrent GPS write. */
  async compareAndSet<T>(key: string, expected: T | null, value: T, ttl: number): Promise<boolean> {
    const result = await this.client.eval(`
      local current = redis.call('GET', KEYS[1])
      if ARGV[1] == 'missing' then
        if current then return 0 end
      elseif current ~= ARGV[2] then return 0 end
      redis.call('SET', KEYS[1], ARGV[3], 'EX', ARGV[4])
      return 1
    `, { keys: [key], arguments: [expected === null ? 'missing' : 'value',
      JSON.stringify(expected), JSON.stringify(value), String(ttl)] });
    return result === 1;
  }

  /** Atomically consumes a JSON value when it matches the expected value. */
  async consumeIfValueMatches<T>(
    key: string,
    expectedValue: T,
  ): Promise<boolean> {
    const result = await this.client.eval(
      `
        local current = redis.call('GET', KEYS[1])
        if current and current == ARGV[1] then
          redis.call('DEL', KEYS[1])
          return 1
        end
        return 0
      `,
      {
        keys: [key],
        arguments: [JSON.stringify(expectedValue)],
      },
    );

    return result === 1;
  }

  async delPattern(pattern: string): Promise<void> {
    const keys = await this.client.keys(pattern);
    if (keys.length > 0) {
      await this.client.del(keys);
    }
  }

  async exists(key: string): Promise<boolean> {
    const result = await this.client.exists(key);
    return result === 1;
  }
}
