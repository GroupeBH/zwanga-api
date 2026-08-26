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
import { GoogleMapsModule } from '../google-maps/google-maps.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { WeatherModule } from '../weather/weather.module';
import { BookingsModule } from '../bookings/bookings.module';
import { DriverSettlementsModule } from '../driver-settlements/driver-settlements.module';
import {
  DriverTripInterruptionConfirmation,
  DriverTripInterruptionRequest,
  PassengerTripInterruptionRequest,
} from './entities/trip-interruption.entity';

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
      PassengerTripInterruptionRequest,
      DriverTripInterruptionRequest,
      DriverTripInterruptionConfirmation,
    ]),
    BookingsModule,
    DriverSettlementsModule,
    NotificationsModule,
    MessagingModule,
    GoogleMapsModule,
    SubscriptionsModule,
    WeatherModule,
  ],
  controllers: [TripsController],
  providers: [TripsService],
  exports: [TripsService],
})
export class TripsModule {}
