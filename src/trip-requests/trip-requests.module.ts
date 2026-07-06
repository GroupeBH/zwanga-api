import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { TripRequestsService } from './trip-requests.service';
import { TripRequestsController } from './trip-requests.controller';
import { TripRequest } from './entities/trip-request.entity';
import { DriverOffer } from './entities/driver-offer.entity';
import { User } from '../users/entities/user.entity';
import { Vehicle } from '../vehicles/entities/vehicle.entity';
import { CommonModule } from '../common/common.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { TripsModule } from '../trips/trips.module';
import { BookingsModule } from '../bookings/bookings.module';
import { GoogleMapsModule } from '../google-maps/google-maps.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { WeatherModule } from '../weather/weather.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([TripRequest, DriverOffer, User, Vehicle]),
    ScheduleModule,
    CommonModule,
    NotificationsModule,
    TripsModule,
    BookingsModule,
    GoogleMapsModule,
    SubscriptionsModule,
    WeatherModule,
  ],
  controllers: [TripRequestsController],
  providers: [TripRequestsService],
  exports: [TripRequestsService],
})
export class TripRequestsModule {}
