import { Module } from '@nestjs/common';
import { RideDeclarationsController } from '../ride-declarations/ride-declarations.controller';
import { RideDeclarationsService } from '../ride-declarations/ride-declarations.service';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BookingsService } from './bookings.service';
import { BookingsController } from './bookings.controller';
import { CashReceiptsController } from './cash-receipts.controller';
import { CashReceiptsService } from './cash-receipts.service';
import { MixedCashPaymentService } from './mixed-cash-payment.service';
import { MixedCashPaymentController } from './mixed-cash-payment.controller';
import { TokenCashFallbackController } from './token-cash-fallback.controller';
import { TokenCashFallbackService } from './token-cash-fallback.service';
import { Booking } from './entities/booking.entity';
import { Trip } from '../trips/entities/trip.entity';
import { User } from '../users/entities/user.entity';
import { NotificationsModule } from '../notifications/notifications.module';
import { MessagingModule } from '../messaging/messaging.module';
import { SafetyModule } from '../safety/safety.module';
import { GoogleMapsModule } from '../google-maps/google-maps.module';
import { PaymentsModule } from '../payments/payments.module';
import { WalletModule } from '../wallet/wallet.module';
import { DriverSettlementsModule } from '../driver-settlements/driver-settlements.module';
import { ReferralsModule } from '../referrals/referrals.module';
import {
  DriverTripInterruptionConfirmation,
  DriverTripInterruptionRequest,
  PassengerTripInterruptionRequest,
} from '../trips/entities/trip-interruption.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Booking,
      Trip,
      User,
      PassengerTripInterruptionRequest,
      DriverTripInterruptionRequest,
      DriverTripInterruptionConfirmation,
    ]),
    NotificationsModule,
    MessagingModule,
    SafetyModule,
    GoogleMapsModule,
    PaymentsModule,
    WalletModule,
    DriverSettlementsModule,
    ReferralsModule,
  ],
  controllers: [BookingsController, RideDeclarationsController, CashReceiptsController, MixedCashPaymentController, TokenCashFallbackController],
  providers: [BookingsService, RideDeclarationsService, CashReceiptsService, MixedCashPaymentService, TokenCashFallbackService],
  exports: [BookingsService],
})
export class BookingsModule {}
