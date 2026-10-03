import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { CacheModule } from '@nestjs/cache-manager';
import { ThrottlerModule } from '@nestjs/throttler';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ConfigModule as AppConfigModule } from './config/config.module';
import { CommonModule } from './common/common.module';
import { LoggerModule } from './common/logger/logger.module';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { IpThrottlerGuard } from './common/guards/throttler.guard';
import { RedisService } from './common/services/redis.service';
import { RedisThrottlerStorage } from './common/services/redis-throttler.storage';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { VehiclesModule } from './vehicles/vehicles.module';
import { TripsModule } from './trips/trips.module';
import { BookingsModule } from './bookings/bookings.module';
import { ChatModule } from './chat/chat.module';
import { RatingsModule } from './ratings/ratings.module';
import { PaymentsModule } from './payments/payments.module';
import { SubscriptionsModule } from './subscriptions/subscriptions.module';
import { NotificationsModule } from './notifications/notifications.module';
import { AdminModule } from './admin/admin.module';
import { SupportModule } from './support/support.module';
import { FaqModule } from './faq/faq.module';
import { TrackingModule } from './tracking/tracking.module';
import { OtpModule } from './otp/otp.module';
import { TripRequestsModule } from './trip-requests/trip-requests.module';
import { SafetyModule } from './safety/safety.module';
import { GoogleMapsModule } from './google-maps/google-maps.module';
import { YandexMapsModule } from './yandex-maps/yandex-maps.module';
import { FavoritePlacesModule } from './favorite-places/favorite-places.module';
import { ChatbotModule } from './chatbot/chatbot.module';
import { buildTypeOrmModuleOptions } from './database/typeorm-options';
import { WalletModule } from './wallet/wallet.module';
import { DriverSettlementsModule } from './driver-settlements/driver-settlements.module';
import { HealthModule } from './health/health.module';
import { createRedisCacheStore } from './common/utils/redis-cache-store';
import { ReferralsModule } from './referrals/referrals.module';
import { ActivityModule } from './activity/activity.module';
import { ProServicesModule } from './pro-services/pro-services.module';

@Module({
  imports: [
    AppConfigModule,
    LoggerModule,
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) =>
        buildTypeOrmModuleOptions(configService),
      inject: [ConfigService],
    }),
    CacheModule.registerAsync({
      isGlobal: true,
      imports: [ConfigModule],
      useFactory: async (configService: ConfigService) => ({
        store: await createRedisCacheStore(configService),
        ttl: 300,
      }),
      inject: [ConfigService],
    }),
    ScheduleModule.forRoot(),
    CommonModule,
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule, CommonModule],
      useFactory: (configService: ConfigService, redis: RedisService) => {
        const ttl = Number(configService.get('THROTTLE_TTL_MS') ??
          Number(configService.get('THROTTLE_TTL') ?? 60) * 1000);
        const limit = Number(configService.get('THROTTLE_LIMIT') ?? 10);
        if (!Number.isFinite(ttl) || ttl < 1000 || !Number.isInteger(limit) || limit < 1) {
          throw new Error('Invalid rate limit configuration: TTL must be >= 1000 ms and limit a positive integer');
        }
        return {
        storage: new RedisThrottlerStorage(redis),
        errorMessage: 'Trop de demandes. Réessayez dans un instant.',
        throttlers: [
          {
            ttl,
            limit,
          },
        ],
        };
      },
      inject: [ConfigService, RedisService],
    }),
    AuthModule,
    UsersModule,
    VehiclesModule,
    TripsModule,
    BookingsModule,
    ChatModule,
    RatingsModule,
    PaymentsModule,
    SubscriptionsModule,
    NotificationsModule,
    AdminModule,
    SupportModule,
    FaqModule,
    TrackingModule,
    OtpModule,
    TripRequestsModule,
    SafetyModule,
    GoogleMapsModule,
    YandexMapsModule,
    FavoritePlacesModule,
    ChatbotModule,
    WalletModule,
    DriverSettlementsModule,
    HealthModule,
    ReferralsModule,
    ActivityModule,
    ProServicesModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
    {
      provide: APP_GUARD,
      useClass: IpThrottlerGuard,
    },
    {
      provide: APP_GUARD,
      useClass: RolesGuard,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: LoggingInterceptor,
    },
  ],
})
export class AppModule {}
