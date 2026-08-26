import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PaymentsModule } from '../payments/payments.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { Booking } from '../bookings/entities/booking.entity';
import { Trip } from '../trips/entities/trip.entity';
import { KycDocument } from '../users/entities/kyc-document.entity';
import { User } from '../users/entities/user.entity';
import { DriverSettlementsController } from './driver-settlements.controller';
import { DriverSettlementsService } from './driver-settlements.service';
import { DriverEarning } from './entities/driver-earning.entity';
import { DriverPayout } from './entities/driver-payout.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      DriverEarning,
      DriverPayout,
      User,
      KycDocument,
      Booking,
      Trip,
    ]),
    PaymentsModule,
    NotificationsModule,
  ],
  controllers: [DriverSettlementsController],
  providers: [DriverSettlementsService],
  exports: [DriverSettlementsService],
})
export class DriverSettlementsModule {}
