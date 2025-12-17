import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BookingsService } from './bookings.service';
import { BookingsController } from './bookings.controller';
import { Booking } from './entities/booking.entity';
import { Trip } from '../trips/entities/trip.entity';
import { User } from '../users/entities/user.entity';
import { NotificationsModule } from '../notifications/notifications.module';
import { ChatModule } from '../chat/chat.module';
import { WhatsAppModule } from '../whatsapp/whatsapp.module';
import { SafetyModule } from '../safety/safety.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Booking, Trip, User]),
    NotificationsModule,
    ChatModule,
    WhatsAppModule,
    SafetyModule,
  ],
  controllers: [BookingsController],
  providers: [BookingsService],
  exports: [BookingsService],
})
export class BookingsModule {}

