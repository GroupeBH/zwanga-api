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
import { WalletAccount } from '../wallet/entities/wallet-account.entity';
import { WalletLedgerEntry } from '../wallet/entities/wallet-ledger-entry.entity';
import { WalletModule } from '../wallet/wallet.module';
import { AdminReferralsService } from './admin-referrals.service';
import { ReferralsModule } from '../referrals/referrals.module';
import { ReferralAccount } from '../referrals/entities/referral-account.entity';
import { ReferralProfile } from '../referrals/entities/referral-profile.entity';
import { ReferralReward } from '../referrals/entities/referral-reward.entity';
import { ReferralWithdrawal } from '../referrals/entities/referral-withdrawal.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      User,
      KycDocument,
      Trip,
      Booking,
      PaymentTransaction,
      WalletAccount,
      WalletLedgerEntry,
      ReferralAccount,
      ReferralProfile,
      ReferralReward,
      ReferralWithdrawal,
      TripRequest,
      DriverOffer,
    ]),
    TripsModule,
    BookingsModule,
    TripRequestsModule,
    WalletModule,
    ReferralsModule,
  ],
  controllers: [AdminController],
  providers: [AdminService, AdminReferralsService],
  exports: [AdminService],
})
export class AdminModule {}
