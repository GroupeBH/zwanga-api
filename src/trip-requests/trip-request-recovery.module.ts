import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NotificationsModule } from '../notifications/notifications.module';
import { User } from '../users/entities/user.entity';
import { Trip } from '../trips/entities/trip.entity';
import { DriverOffer } from './entities/driver-offer.entity';
import { TripRequest } from './entities/trip-request.entity';
import { TripRequestRecoveryService } from './trip-request-recovery.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([TripRequest, DriverOffer, User, Trip]),
    NotificationsModule,
  ],
  providers: [TripRequestRecoveryService],
  exports: [TripRequestRecoveryService],
})
export class TripRequestRecoveryModule {}
