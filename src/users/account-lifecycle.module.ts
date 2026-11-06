import { Module } from '@nestjs/common';
import { WalletModule } from '../wallet/wallet.module';
import { AccountLifecycleService } from './account-lifecycle.service';

@Module({ imports: [WalletModule], providers: [AccountLifecycleService], exports: [AccountLifecycleService] })
export class AccountLifecycleModule {}
