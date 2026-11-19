import { Module } from '@nestjs/common';
import { CreditCoreModule } from '../shared/credit-shared.module';
import { CreditCatalogueModule } from '../catalogue/credit-catalogue.module';
import { CreditEligibilityModule } from '../eligibility/credit-eligibility.module';
import { CreditApplicationsController } from './credit-applications.controller';
import { CreditApplicationsService } from './credit-applications.service';

@Module({
  imports: [CreditCoreModule, CreditCatalogueModule, CreditEligibilityModule],
  controllers: [CreditApplicationsController],
  providers: [CreditApplicationsService],
  exports: [CreditApplicationsService],
})
export class CreditApplicationsModule {}
