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
import { KeccelOtpModule } from './keccel-otp/keccel-otp.module';
import { TripRequestsModule } from './trip-requests/trip-requests.module';
import { SafetyModule } from './safety/safety.module';
import { GoogleMapsModule } from './google-maps/google-maps.module';
import { FavoritePlacesModule } from './favorite-places/favorite-places.module';
import { ChatbotModule } from './chatbot/chatbot.module';
import { buildTypeOrmModuleOptions } from './database/typeorm-options';

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
    CacheModule.register({
      isGlobal: true,
      ttl: 300, // 5 minutes default TTL
    }),
    ScheduleModule.forRoot(),
    CommonModule,
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        throttlers: [
          {
            ttl: configService.get<number>('THROTTLE_TTL') ?? 60,
            limit: configService.get<number>('THROTTLE_LIMIT') ?? 10,
          },
        ],
      }),
      inject: [ConfigService],
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
    KeccelOtpModule,
    TripRequestsModule,
    SafetyModule,
    GoogleMapsModule,
    FavoritePlacesModule,
    ChatbotModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_GUARD,
      useClass: IpThrottlerGuard,
    },
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
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
