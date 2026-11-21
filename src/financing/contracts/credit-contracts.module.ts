import { Module } from '@nestjs/common';
import { CreditCoreModule } from '../shared/credit-shared.module';
import { CreditCatalogueModule } from '../catalogue/credit-catalogue.module';
import { CreditEligibilityModule } from '../eligibility/credit-eligibility.module';
import { CreditContractsController } from './credit-contracts.controller';
import { CreditContractsService } from './credit-contracts.service';

@Module({
  imports: [CreditCoreModule, CreditCatalogueModule, CreditEligibilityModule],
  controllers: [CreditContractsController],
  providers: [CreditContractsService],
  exports: [CreditContractsService],
})
export class CreditContractsModule {}
