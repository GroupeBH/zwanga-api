import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminService } from './admin.service';
import { AccountLifecycleModule } from '../users/account-lifecycle.module';
import { KycEvidenceModule } from '../users/kyc-evidence/kyc-evidence.module';
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
import { DriverEarning } from '../driver-settlements/entities/driver-earning.entity';
import { TripStatementService } from './trip-statement.service';
import { Vehicle } from '../vehicles/entities/vehicle.entity';
import { VehiclesModule } from '../vehicles/vehicles.module';
import { AdminVehiclesController } from './admin-vehicles.controller';
import { AdminVehiclesService } from './admin-vehicles.service';
import { StoreManagementModule } from '../store-management/store-management.module';
import { PaymentsModule } from '../payments/payments.module';
import { AdminPaymentsController } from './admin-payments.controller';
import { AdminPaymentReconciliationService } from './admin-payment-reconciliation.service';
import { AdminDirectPayoutService } from './admin-direct-payout.service';
import { AdminDirectPayoutController } from './admin-direct-payout.controller';
import { AdminAnalyticsController } from './admin-analytics.controller';
import { AdminAnalyticsService } from './admin-analytics.service';
import { AdminFinanceOtpController } from './admin-finance-otp.controller';
import { FinanceOtpModule } from '../otp/finance-otp.module';

@Module({
  imports: [
    FinanceOtpModule,
    AccountLifecycleModule,
    StoreManagementModule,
    KycEvidenceModule,
    TypeOrmModule.forFeature([
      User,
      Vehicle,
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
      DriverEarning,
    ]),
    TripsModule,
    BookingsModule,
    TripRequestsModule,
    WalletModule,
    ReferralsModule,
    VehiclesModule,
    PaymentsModule,
  ],
  controllers: [AdminController, AdminAnalyticsController, AdminVehiclesController, AdminPaymentsController, AdminDirectPayoutController, AdminFinanceOtpController],
  providers: [
    AdminService,
    AdminAnalyticsService,
    AdminReferralsService,
    TripStatementService,
    AdminVehiclesService,
    AdminPaymentReconciliationService,
    AdminDirectPayoutService,
  ],
  exports: [AdminService],
})
export class AdminModule {}
