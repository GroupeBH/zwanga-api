import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Booking } from '../bookings/entities/booking.entity';
import { Trip } from '../trips/entities/trip.entity';
import { TrackingGateway } from './tracking.gateway';
import { TripsModule } from '../trips/trips.module';
import { BookingsModule } from '../bookings/bookings.module';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule } from '@nestjs/config';
import { TripShareLink } from './entities/trip-share-link.entity';
import { TrackingController } from './tracking.controller';
import { TrackingService } from './tracking.service';

@Module({
  imports: [
    TripsModule,
    BookingsModule,
    JwtModule,
    ConfigModule,
    TypeOrmModule.forFeature([TripShareLink, Trip, Booking]),
  ],
  controllers: [TrackingController],
  providers: [TrackingGateway, TrackingService],
})
export class TrackingModule {}

