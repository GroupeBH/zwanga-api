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

// Entities
import { User } from './users/entities/user.entity';
import { KycDocument } from './users/entities/kyc-document.entity';
import { Vehicle } from './vehicles/entities/vehicle.entity';
import { Trip } from './trips/entities/trip.entity';
import { RecurringTripTemplate } from './trips/entities/recurring-trip-template.entity';
import { Booking } from './bookings/entities/booking.entity';
import { Message } from './chat/entities/message.entity';
import { Rating } from './ratings/entities/rating.entity';
import { Subscription } from './subscriptions/entities/subscription.entity';
import { Conversation } from './chat/entities/conversation.entity';
import { ConversationParticipant } from './chat/entities/conversation-participant.entity';
import { FaqEntry } from './faq/entities/faq-entry.entity';
import { TripRequest } from './trip-requests/entities/trip-request.entity';
import { DriverOffer } from './trip-requests/entities/driver-offer.entity';
import { EmergencyContact } from './safety/entities/emergency-contact.entity';
import { SafetyAlert } from './safety/entities/safety-alert.entity';
import { UserReport } from './safety/entities/user-report.entity';
import { Notification } from './notifications/entities/notification.entity';
import { FavoriteLocation } from './users/entities/favorite-location.entity';
import { FavoritePlace } from './favorite-places/entities/favorite-place.entity';
import { SupportTicket } from './support/entities/support-ticket.entity';
import { SupportTicketMessage } from './support/entities/support-ticket-message.entity';

const typeOrmEntities = [
  User,
  KycDocument,
  Vehicle,
  Trip,
  RecurringTripTemplate,
  Booking,
  Message,
  Rating,
  Subscription,
  Conversation,
  ConversationParticipant,
  FaqEntry,
  TripRequest,
  DriverOffer,
  EmergencyContact,
  SafetyAlert,
  UserReport,
  Notification,
  FavoritePlace,
  FavoriteLocation,
  SupportTicket,
  SupportTicketMessage,
];

@Module({
  imports: [
    AppConfigModule,
    LoggerModule,
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        ...((
          databaseUrl: string | undefined,
          isDevelopment: boolean,
        ) => {
          const baseConfig = {
            type: 'postgres' as const,
            entities: typeOrmEntities,
            synchronize: true,
            // Disable SQL query logging to keep logs clean
            // Set to ['error', 'warn'] if you want to see TypeORM errors/warnings only
            logging: false,
          };

          if (databaseUrl) {
            const sslDisabled = databaseUrl.includes('sslmode=disable');
            return {
              ...baseConfig,
              url: databaseUrl,
              ssl: sslDisabled
                ? undefined
                : {
                    rejectUnauthorized: false,
                  },
              extra: sslDisabled ? undefined : { sslmode: 'require' },
            };
          }

          return {
            ...baseConfig,
            host: configService.get<string>('DATABASE_HOST'),
            port: configService.get<number>('DATABASE_PORT'),
            username: configService.get<string>('DATABASE_USER'),
            password: configService.get<string>('DATABASE_PASSWORD'),
            database: configService.get<string>('DATABASE_NAME'),
          };
        })(configService.get<string>('DATABASE_URL'), configService.get<string>('NODE_ENV') === 'development'),
      }),
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
