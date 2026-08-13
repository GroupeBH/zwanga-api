import { NestFactory } from '@nestjs/core';
import { ValidationPipe, BadRequestException } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { NestExpressApplication } from '@nestjs/platform-express';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston';
import { join } from 'path';
import { AppModule } from './app.module';
import { RedisIoAdapter } from './common/adapters/redis-io.adapter';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
  });

  app.useLogger(app.get(WINSTON_MODULE_NEST_PROVIDER));

  const configService = app.get(ConfigService);
  const apiPrefix = configService.get<string>('API_PREFIX') || 'api/v1';
  const redisIoAdapter = new RedisIoAdapter(app, configService);
  await redisIoAdapter.connectToRedis();
  app.useWebSocketAdapter(redisIoAdapter);

  // Global prefix
  app.setGlobalPrefix(apiPrefix);

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

bootstrap();
