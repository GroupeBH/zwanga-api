import { Module } from '@nestjs/common';
import { NotificationService } from './notifications.service';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Trip } from '../trips/entities/trip.entity';
import { Booking } from '../bookings/entities/booking.entity';
import { User } from '../users/entities/user.entity';
import { TripAvailabilityNotificationService } from './trip-availability-notification.service';

@Module({
  imports: [ConfigModule, TypeOrmModule.forFeature([Trip, Booking, User])],
  providers: [NotificationService, TripAvailabilityNotificationService],
  exports: [NotificationService],
})
export class NotificationsModule {}

