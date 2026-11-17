import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import { UsersService } from './users.service';
import { AccountLifecycleModule } from './account-lifecycle.module';
import { UsersController } from './users.controller';
import { PublicDriverController } from './public-driver/public-driver.controller';
import { PublicDriverService } from './public-driver/public-driver.service';
import { User } from './entities/user.entity';
import { KycDocument } from './entities/kyc-document.entity';
import { Trip } from '../trips/entities/trip.entity';
import { Booking } from '../bookings/entities/booking.entity';
import { Message } from '../chat/entities/message.entity';
import { FavoriteLocation } from './entities/favorite-location.entity';
import { Rating } from '../ratings/entities/rating.entity';
import { Vehicle } from '../vehicles/entities/vehicle.entity';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { DiditKycService } from './didit-kyc.service';
import { OtpModule } from '../otp/otp.module';
import { KycEvidenceModule } from './kyc-evidence/kyc-evidence.module';
import { AwsKycModule } from './aws-kyc/aws-kyc.module';

@Module({
  imports: [
    AccountLifecycleModule,
    TypeOrmModule.forFeature([
      User,
      KycDocument,
      Trip,
      Booking,
      Message,
      FavoriteLocation,
      Rating,
      Vehicle,
    ]),
    ConfigModule,
    OtpModule,
    KycEvidenceModule,
    AwsKycModule,
    SubscriptionsModule,
  ],
  controllers: [UsersController, PublicDriverController],
  providers: [UsersService, DiditKycService, PublicDriverService],
  exports: [UsersService, DiditKycService],
})
export class UsersModule {}
