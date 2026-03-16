import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { SafetyController } from './safety.controller';
import { SafetyService } from './safety.service';
import { EmergencyContact } from './entities/emergency-contact.entity';
import { SafetyAlert } from './entities/safety-alert.entity';
import { UserReport } from './entities/user-report.entity';
import { User } from '../users/entities/user.entity';
import { Trip } from '../trips/entities/trip.entity';
import { Booking } from '../bookings/entities/booking.entity';
import { NotificationsModule } from '../notifications/notifications.module';
import { TripSafetyParticipant } from './entities/trip-safety-participant.entity';
import { TripSafetyContact } from './entities/trip-safety-contact.entity';
import { TripSafetyEvent } from './entities/trip-safety-event.entity';
import { TripSafetyNotification } from './entities/trip-safety-notification.entity';
import { TripSecurityService } from './trip-security.service';
import { TripSecurityController } from './trip-security.controller';
import { WhatsAppModule } from '../whatsapp/whatsapp.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      EmergencyContact,
      SafetyAlert,
      UserReport,
      User,
      Trip,
      Booking,
      TripSafetyParticipant,
      TripSafetyContact,
      TripSafetyEvent,
      TripSafetyNotification,
    ]),
    ScheduleModule,
    NotificationsModule,
    WhatsAppModule,
  ],
  controllers: [SafetyController, TripSecurityController],
  providers: [SafetyService, TripSecurityService],
  exports: [SafetyService, TripSecurityService],
})
export class SafetyModule {}

