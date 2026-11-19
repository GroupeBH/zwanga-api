import { Module } from '@nestjs/common';
import { CreditCoreModule } from '../shared/credit-shared.module';
import { CreditCatalogueController } from './credit-catalogue.controller';
import { CreditCatalogService } from './credit-catalogue.service';

@Module({
  imports: [CreditCoreModule],
  controllers: [CreditCatalogueController],
  providers: [CreditCatalogService],
  exports: [CreditCatalogService],
})
export class CreditCatalogueModule {}
