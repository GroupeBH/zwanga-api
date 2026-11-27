import { Module } from '@nestjs/common';
import { WalletModule } from '../wallet/wallet.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { DriverFinanceController } from './driver-finance.controller';
import { DriverFinanceService } from './driver-finance.service';
import { AccountLifecycleModule } from '../users/account-lifecycle.module';
import { CashRestrictionRetirementService } from './cash-restriction-retirement.service';

@Module({
  imports: [WalletModule, SubscriptionsModule, AccountLifecycleModule],
  controllers: [DriverFinanceController],
  providers: [DriverFinanceService, CashRestrictionRetirementService],
})
export class DriverFinanceModule {}
