import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { createClient, RedisClientType } from 'redis';
import type { ServerOptions } from 'socket.io';
import type { INestApplicationContext } from '@nestjs/common';

export class RedisIoAdapter extends IoAdapter {
  private readonly logger = new Logger(RedisIoAdapter.name);
  private pubClient?: RedisClientType;
  private subClient?: RedisClientType;
  private redisAdapter?: ReturnType<typeof createAdapter>;

  constructor(
    app: INestApplicationContext,
    private readonly configService: ConfigService,
  ) {
    super(app);
  }

  async connectToRedis(): Promise<void> {
    const redisUrl = this.configService.get<string>('REDIS_URL')?.trim();

    if (!redisUrl) {
      this.logger.warn(
        'REDIS_URL is not configured; Socket.IO will run without the Redis adapter.',
      );
      return;
    }

    const socket = redisUrl.startsWith('rediss://') ? { tls: true } : undefined;
    this.pubClient = createClient({ url: redisUrl, socket });
    this.subClient = this.pubClient.duplicate();

    this.pubClient.on('error', (error) => {
      this.logger.error(`Socket.IO Redis pub client error: ${error.message}`);
    });
    this.subClient.on('error', (error) => {
      this.logger.error(`Socket.IO Redis sub client error: ${error.message}`);
    });

    await Promise.all([this.pubClient.connect(), this.subClient.connect()]);
    this.redisAdapter = createAdapter(this.pubClient, this.subClient);

    this.logger.log('Socket.IO Redis adapter connected.');
  }

  createIOServer(port: number, options?: ServerOptions): any {
    const server = super.createIOServer(port, options);

    if (this.redisAdapter) {
      server.adapter(this.redisAdapter);
    }

    return server;
  }

  async close(): Promise<void> {
    await Promise.allSettled([this.subClient?.quit(), this.pubClient?.quit()]);
  }
}
