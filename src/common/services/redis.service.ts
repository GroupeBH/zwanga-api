import { createClient } from 'redis';
import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private client: ReturnType<typeof createClient>;

  constructor(private configService: ConfigService) {}

  async onModuleInit() {
    const redisUrl = this.configService.get<string>('REDIS_URL');
    const host = this.configService.get<string>('REDIS_HOST') || 'localhost';
    const port = this.configService.get<number>('REDIS_PORT') || 6379;
    const password = this.configService.get<string>('REDIS_PASSWORD') || undefined;

    if (redisUrl) {
      this.logger.log(`Connecting to Redis via URL (${redisUrl.includes('upstash') ? 'Upstash' : 'custom'}).`);
      this.client = createClient({
        url: redisUrl,
        socket: redisUrl.startsWith('rediss://')
          ? {
              tls: true,
            }
          : undefined,
      });
    } else {
      this.client = createClient({
        socket: {
          host,
          port,
        },
        password,
      });
    }

    this.client.on('error', (err) => {
      this.logger.error('Redis Client Error:', err);
    });
    this.client.on('connect', () => {
      this.logger.log('Redis Client Connected');
    });

    await this.client.connect();
    if (redisUrl) {
      this.logger.log(`Redis connected via URL (${redisUrl}).`);
    } else {
      this.logger.log(`Redis connected to ${host}:${port}`);
    }
  }

  async onModuleDestroy() {
    this.logger.log('Disconnecting Redis client');
    await this.client.quit();
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

