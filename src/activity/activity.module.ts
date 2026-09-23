import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Trip } from '../trips/entities/trip.entity';
import { Booking } from '../bookings/entities/booking.entity';
import { TripRequest } from '../trip-requests/entities/trip-request.entity';
import { ActivityService } from './activity.service';
import { ActivityController } from './activity.controller';

@Module({
  imports: [TypeOrmModule.forFeature([Trip, Booking, TripRequest])],
  controllers: [ActivityController],
  providers: [ActivityService],
})
export class ActivityModule {}
