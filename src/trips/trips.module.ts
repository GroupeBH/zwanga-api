import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TripsService } from './trips.service';
import { TripsController } from './trips.controller';
import { Trip } from './entities/trip.entity';
import { User } from '../users/entities/user.entity';
import { Booking } from '../bookings/entities/booking.entity';
import { Vehicle } from '../vehicles/entities/vehicle.entity';
import { TripRequest } from '../trip-requests/entities/trip-request.entity';
import { KycDocument } from '../users/entities/kyc-document.entity';
import { NotificationsModule } from '../notifications/notifications.module';
import { Rating } from '../ratings/entities/rating.entity';
import { EmergencyContact } from '../safety/entities/emergency-contact.entity';
import { MessagingModule } from '../messaging/messaging.module';
import { RecurringTripTemplate } from './entities/recurring-trip-template.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Trip,
      User,
      Booking,
      Vehicle,
      TripRequest,
      KycDocument,
      Rating,
      EmergencyContact,
      RecurringTripTemplate,
    ]),
    NotificationsModule,
    MessagingModule,
  ],
  controllers: [TripsController],
  providers: [TripsService],
  exports: [TripsService],
})
export class TripsModule {}

