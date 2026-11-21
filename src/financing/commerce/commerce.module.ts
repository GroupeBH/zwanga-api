import { Module } from '@nestjs/common';
import { CreditCoreModule } from '../shared/credit-shared.module';
import { CreditCatalogueModule } from '../catalogue/credit-catalogue.module';
import { CommerceCatalogueController } from './commerce-catalogue.controller';
import { CommerceCatalogueService } from './commerce-catalogue.service';
import { CreditLedgerModule } from '../ledger/credit-ledger.module';
import { CommercePaymentsService } from './commerce-payments.service';
import { CommercePaymentsController } from './commerce-payments.controller';
@Module({
  imports: [CreditCoreModule, CreditCatalogueModule, CreditLedgerModule],
  controllers: [CommerceCatalogueController, CommercePaymentsController],
  providers: [CommerceCatalogueService, CommercePaymentsService],
})
export class CommerceModule {}
