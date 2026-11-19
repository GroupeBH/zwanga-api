import { Module } from '@nestjs/common';
import { CreditCoreModule } from '../shared/credit-shared.module';
import { CreditLedgerController } from './credit-ledger.controller';
import { CreditLedgerService } from './credit-ledger.service';

@Module({
  imports: [CreditCoreModule],
  controllers: [CreditLedgerController],
  providers: [CreditLedgerService],
  exports: [CreditLedgerService],
})
export class CreditLedgerModule {}
