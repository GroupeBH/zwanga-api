import { Module } from '@nestjs/common';
import { NotificationService } from './notifications.service';
import { NotificationsController } from './notifications.controller';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Trip } from '../trips/entities/trip.entity';
import { Booking } from '../bookings/entities/booking.entity';
import { User } from '../users/entities/user.entity';
import { Notification } from './entities/notification.entity';
import { TripRequest } from '../trip-requests/entities/trip-request.entity';
import { TripAvailabilityNotificationService } from './trip-availability-notification.service';
import { DailyEngagementNotificationService } from './daily-engagement-notification.service';
import { TransactionalNotificationsSubscriber } from './transactional-notifications.subscriber';
import { RideAlertRealtime } from './ride-alert-realtime.service';
import { RideAlertChanges } from './ride-alert-changes';

@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forFeature([Trip, Booking, User, Notification, TripRequest]),
  ],
  controllers: [NotificationsController],
  providers: [
    NotificationService,
    RideAlertRealtime,
    RideAlertChanges,
    TripAvailabilityNotificationService,
    DailyEngagementNotificationService,
    TransactionalNotificationsSubscriber,
  ],
  exports: [NotificationService, RideAlertRealtime, RideAlertChanges],
})
export class NotificationsModule {}
