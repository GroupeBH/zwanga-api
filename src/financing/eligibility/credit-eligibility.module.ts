import { Module } from '@nestjs/common';
import { CreditCoreModule } from '../shared/credit-shared.module';
import { CreditEligibilityService } from './credit-eligibility.service';

@Module({
  imports: [CreditCoreModule],
  controllers: [],
  providers: [CreditEligibilityService],
  exports: [CreditEligibilityService],
})
export class CreditEligibilityModule {}
