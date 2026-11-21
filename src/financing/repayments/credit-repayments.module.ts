import { Module } from '@nestjs/common';
import { CreditCoreModule } from '../shared/credit-shared.module';
import { CreditCatalogueModule } from '../catalogue/credit-catalogue.module';
import { CreditLedgerModule } from '../ledger/credit-ledger.module';
import { CreditRepaymentsController } from './credit-repayments.controller';
import { CreditWalletPaymentsService } from './credit-wallet-payments.service';
import { TripCreditRepaymentWorker } from './trip-credit-repayment.worker';

@Module({
  imports: [CreditCoreModule, CreditCatalogueModule, CreditLedgerModule],
  controllers: [CreditRepaymentsController],
  providers: [CreditWalletPaymentsService, TripCreditRepaymentWorker],
  exports: [CreditWalletPaymentsService],
})
export class CreditRepaymentsModule {}
