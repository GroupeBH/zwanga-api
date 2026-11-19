import { Module } from '@nestjs/common';
import { CreditCoreModule } from '../shared/credit-shared.module';
import { CreditPoliciesController } from './credit-policies.controller';
import { CreditPoliciesService } from './credit-policies.service';

@Module({
  imports: [CreditCoreModule],
  controllers: [CreditPoliciesController],
  providers: [CreditPoliciesService],
  exports: [CreditPoliciesService],
})
export class CreditPoliciesModule {}
