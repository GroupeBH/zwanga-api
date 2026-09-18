import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PaymentsModule } from '../payments/payments.module';
import { User } from '../users/entities/user.entity';
import { WalletAccount } from './entities/wallet-account.entity';
import { WalletLedgerEntry } from './entities/wallet-ledger-entry.entity';
import { WalletController } from './wallet.controller';
import { WalletService } from './wallet.service';
import { WalletWithdrawalsService } from './wallet-withdrawals.service';
import { WalletWithdrawal } from './entities/wallet-withdrawal.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      WalletAccount,
      WalletLedgerEntry,
      WalletWithdrawal,
      User,
    ]),
    PaymentsModule,
  ],
  controllers: [WalletController],
  providers: [WalletService, WalletWithdrawalsService],
  exports: [WalletService],
})
export class WalletModule {}
