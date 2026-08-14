import { NestFactory } from '@nestjs/core';
import {
  ValidationPipe,
  BadRequestException,
  Logger,
  ShutdownSignal,
} from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { NestExpressApplication } from '@nestjs/platform-express';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston';
import { join } from 'path';
import { AppModule } from './app.module';
import { createAdapter } from '@socket.io/redis-adapter';
import { createClient } from 'redis';
import {
  buildRedisClientOptions,
  redisOptionsUseTls,
} from './common/utils/redis-options';
import type { Server, ServerOptions } from 'socket.io';
import type { Server as HttpServer } from 'http';
import type { Socket } from 'net';

class RedisSocketIoAdapter extends IoAdapter {
  private redisAdapter?: ReturnType<typeof createAdapter>;
  private readonly socketIoServers = new Set<Server>();
  private pubClient?: ReturnType<typeof createClient>;
  private subClient?: ReturnType<typeof createClient>;

  constructor(app: NestExpressApplication) {
    super(app);
  }

  setRedisAdapter(redisAdapter: ReturnType<typeof createAdapter>): void {
    this.redisAdapter = redisAdapter;
    for (const server of this.socketIoServers) {
      if ('adapter' in server && typeof server.adapter === 'function') {
        server.adapter(redisAdapter);
      }
    }
  }

  setRedisClients(
    pubClient: ReturnType<typeof createClient>,
    subClient: ReturnType<typeof createClient>,
  ): void {
    this.pubClient = pubClient;
    this.subClient = subClient;
  }

  createIOServer(port: number, options?: ServerOptions): Server {
    const io = super.createIOServer(port, options) as Server;
    this.socketIoServers.add(io);
    if (this.redisAdapter) {
      io.adapter(this.redisAdapter);
    }
    return io;
  }

  async dispose(): Promise<void> {
    await super.dispose();
    await Promise.allSettled([
      this.subClient?.isOpen ? this.subClient.quit() : Promise.resolve(),
      this.pubClient?.isOpen ? this.pubClient.quit() : Promise.resolve(),
    ]);
  }
}

async function configureSocketIoRedisAdapter(
  redisIoAdapter: RedisSocketIoAdapter,
  configService: ConfigService,
): Promise<void> {
  const logger = new Logger('Socket.IO');
  const redisOptions = buildRedisClientOptions(configService);
  const pubClient = createClient(redisOptions);
  const subClient = pubClient.duplicate();

  pubClient.on('error', (error) => {
    logger.error(`Redis pub client error: ${error.message}`);
  });
  subClient.on('error', (error) => {
    logger.error(`Redis sub client error: ${error.message}`);
  });

  try {
    await Promise.all([pubClient.connect(), subClient.connect()]);
  } catch (error) {
    await Promise.allSettled([subClient.quit(), pubClient.quit()]);
    logger.error('Redis is unavailable; refusing to start Socket.IO.');
    throw error;
  }

  redisIoAdapter.setRedisClients(pubClient, subClient);
  redisIoAdapter.setRedisAdapter(createAdapter(pubClient, subClient));
  logger.log(
    `Redis adapter connected${redisOptionsUseTls(redisOptions) ? ' with TLS' : ''}`,
  );
}

function configureHttpGracefulShutdown(app: NestExpressApplication): void {
  const logger = new Logger('GracefulShutdown');
  let shuttingDown = false;
  const server = app.getHttpServer() as HttpServer & {
    closeIdleConnections?: () => void;
    closeAllConnections?: () => void;
  };
  const sockets = new Set<Socket>();

  server.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  process.once('SIGTERM', () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    logger.warn(
      'SIGTERM received; draining HTTP requests before application shutdown',
    );
    server.closeIdleConnections?.();

    const forceCloseTimer = setTimeout(() => {
      logger.warn(
        `Force closing ${sockets.size} remaining HTTP connection(s) after 30s`,
      );
      server.closeAllConnections?.();
      for (const socket of sockets) {
        socket.destroy();
      }
    }, 30_000);
    forceCloseTimer.unref();
  });
}

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    forceCloseConnections: false,
  });

  app.useLogger(app.get(WINSTON_MODULE_NEST_PROVIDER));
  configureHttpGracefulShutdown(app);
  app.enableShutdownHooks([ShutdownSignal.SIGTERM, ShutdownSignal.SIGINT], {
    useProcessExit: true,
  });

  const configService = app.get(ConfigService);
  const apiPrefix = configService.get<string>('API_PREFIX') || 'api/v1';
  const redisIoAdapter = new RedisSocketIoAdapter(app);
  app.useWebSocketAdapter(redisIoAdapter);
  await configureSocketIoRedisAdapter(redisIoAdapter, configService);

  // Global prefix
  app.setGlobalPrefix(apiPrefix, {
    exclude: ['health'],
  });

  // Global validation pipe
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: {
        enableImplicitConversion: true,
      },
      exceptionFactory: (errors) => {
        const messages = errors
          .map((error) => {
            const constraints = error.constraints
              ? Object.values(error.constraints)
              : [`${error.property} has invalid value`];
            return constraints;
          })
          .flat();
        return new BadRequestException({
          error: 'Bad Request',
          message: messages,
          statusCode: 400,
        });
      },
    }),
  );

  // CORS
  const corsOrigins =
    configService
      .get<string>('CORS_ORIGINS')
      ?.split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0) ?? [];
  const isProduction =
    (configService.get<string>('NODE_ENV') || 'development') === 'production';

  app.enableCors({
    origin: (origin, callback) => {
      // Native mobile clients often do not send Origin header.
      if (!origin) {
        callback(null, true);
        return;
      }

      // In non-production, allow all origins for local mobile/web testing.
      if (!isProduction) {
        callback(null, true);
        return;
      }

      if (corsOrigins.includes(origin)) {
        callback(null, true);
        return;
      }

      callback(new Error(`Origin ${origin} is not allowed by CORS`));
    },
    methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
    credentials: true,
  });

  // Serve static files (uploads) - only if not using S3
  const useS3 = configService.get<string>('AWS_S3_BUCKET_NAME') ? true : false;
  if (!useS3) {
    const uploadDest = configService.get<string>('UPLOAD_DEST') || './uploads';
    app.useStaticAssets(join(process.cwd(), uploadDest), {
      prefix: '/uploads',
    });
  }

  // Swagger configuration
  const config = new DocumentBuilder()
    .setTitle('ZWANGA API')
    .setDescription('API documentation for ZWANGA carpooling platform')
    .setVersion('1.0')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        name: 'JWT',
        description: 'Enter JWT token',
        in: 'header',
      },
      'JWT-auth',
    )
    .addTag('Auth', 'Authentication endpoints')
    .addTag('Users', 'User management endpoints')
    .addTag('Vehicles', 'Vehicle management endpoints')
    .addTag('Trips', 'Trip management endpoints')
    .addTag('Bookings', 'Booking management endpoints')
    .addTag('Tracking', 'Trip tracking and public sharing endpoints')
    .addTag('Chat', 'Chat endpoints')
    .addTag('Ratings', 'Rating endpoints')
    .addTag('Payments', 'Payment endpoints')
    .addTag('Wallet', 'Points wallet endpoints')
    .addTag('Driver Settlements', 'Driver earnings and payout endpoints')
    .addTag('Subscriptions', 'Subscription endpoints')
    .addTag('Admin', 'Admin endpoints')
    .addTag('Support', 'Support & helpdesk endpoints')
    .addTag('FAQ', 'Foire aux questions')
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup(`${apiPrefix}/docs`, app, document);

  const port = configService.get<number>('PORT') || 5200;
  const host = configService.get<string>('HOST') || '0.0.0.0';
  await app.listen(port, host);

  console.log(
    `Application zwanga backend is running on host ${host} and port ${port}`,
  );
  console.log(
    `Swagger documentation: http://localhost:${port}/${apiPrefix}/docs`,
  );
}

bootstrap().catch((error) => {
  const logger = new Logger('Bootstrap');
  logger.error(error?.message || 'Application failed to start', error?.stack);
  process.exit(1);
});
