import { Module } from '@nestjs/common';
import { CreditCoreModule } from '../shared/credit-shared.module';
import { CreditCollectionsController } from './credit-collections.controller';
import { CreditCollectionsService } from './credit-collections.service';

@Module({
  imports: [CreditCoreModule],
  controllers: [CreditCollectionsController],
  providers: [CreditCollectionsService],
})
export class CreditCollectionsModule {}
