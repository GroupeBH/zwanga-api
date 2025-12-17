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

@Module({
  imports: [
    TypeOrmModule.forFeature([
      EmergencyContact,
      SafetyAlert,
      UserReport,
      User,
      Trip,
      Booking,
    ]),
    ScheduleModule,
    NotificationsModule,
  ],
  controllers: [SafetyController],
  providers: [SafetyService],
  exports: [SafetyService],
})
export class SafetyModule {}

