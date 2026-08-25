import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PaymentsModule } from '../payments/payments.module';
import { PaymentTransaction } from '../payments/entities/payment-transaction.entity';
import { KycDocument } from '../users/entities/kyc-document.entity';
import { User } from '../users/entities/user.entity';
import { ReferralAccount } from './entities/referral-account.entity';
import { ReferralLedgerEntry } from './entities/referral-ledger-entry.entity';
import { ReferralProfile } from './entities/referral-profile.entity';
import { ReferralReward } from './entities/referral-reward.entity';
import { ReferralWithdrawal } from './entities/referral-withdrawal.entity';
import { ReferralsController } from './referrals.controller';
import { ReferralsService } from './referrals.service';

@Module({
  imports: [
    HttpModule.register({ timeout: 10000, maxRedirects: 0 }),
    TypeOrmModule.forFeature([
      ReferralProfile,
      ReferralAccount,
      ReferralReward,
      ReferralLedgerEntry,
      ReferralWithdrawal,
      User,
      KycDocument,
      PaymentTransaction,
    ]),
    PaymentsModule,
  ],
  controllers: [ReferralsController],
  providers: [ReferralsService],
  exports: [ReferralsService],
})
export class ReferralsModule {}
