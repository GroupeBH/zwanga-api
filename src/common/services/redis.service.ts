import { createClient } from 'redis';
import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  buildRedisClientOptions,
  redisOptionsUseTls,
} from '../utils/redis-options';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private client: ReturnType<typeof createClient>;

  constructor(private configService: ConfigService) {}

  async onModuleInit() {
    const redisOptions = buildRedisClientOptions(this.configService);
    this.client = createClient(redisOptions);

    this.client.on('error', (err) => {
      this.logger.error('Redis Client Error:', err);
    });
    this.client.on('connect', () => {
      this.logger.log('Redis Client Connected');
    });

    await this.client.connect();
    this.logger.log(
      `Redis connected${redisOptionsUseTls(redisOptions) ? ' with TLS' : ''}`,
    );
  }

  async onModuleDestroy() {
    this.logger.log('Disconnecting Redis client');
    if (this.client?.isOpen) {
      await this.client.quit();
    }
    this.logger.log('Redis client disconnected');
  }

  getClient() {
    return this.client;
  }

  async get<T>(key: string): Promise<T | null> {
    const value = await this.client.get(key);
    return value ? JSON.parse(value) : null;
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

