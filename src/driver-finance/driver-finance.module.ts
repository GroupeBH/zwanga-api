import { Module } from '@nestjs/common';
import { WalletModule } from '../wallet/wallet.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { DriverFinanceController } from './driver-finance.controller';
import { DriverFinanceService } from './driver-finance.service';

@Module({
  imports: [WalletModule, SubscriptionsModule],
  controllers: [DriverFinanceController],
  providers: [DriverFinanceService],
})
export class DriverFinanceModule {}
