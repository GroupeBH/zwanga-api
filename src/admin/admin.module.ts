import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminService } from './admin.service';
import { AdminController } from './admin.controller';
import { User } from '../users/entities/user.entity';
import { KycDocument } from '../users/entities/kyc-document.entity';
import { Trip } from '../trips/entities/trip.entity';
import { Booking } from '../bookings/entities/booking.entity';
import { PaymentTransaction } from '../payments/entities/payment-transaction.entity';
import { TripRequest } from '../trip-requests/entities/trip-request.entity';
import { DriverOffer } from '../trip-requests/entities/driver-offer.entity';
import { TripsModule } from '../trips/trips.module';
import { TripRequestsModule } from '../trip-requests/trip-requests.module';
import { BookingsModule } from '../bookings/bookings.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      User,
      KycDocument,
      Trip,
      Booking,
      PaymentTransaction,
      TripRequest,
      DriverOffer,
    ]),
    TripsModule,
    BookingsModule,
    TripRequestsModule,
  ],
  controllers: [AdminController],
  providers: [AdminService],
  exports: [AdminService],
})
export class AdminModule {}

