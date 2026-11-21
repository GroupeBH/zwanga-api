import { Module } from '@nestjs/common';
import { CreditCoreModule } from '../shared/credit-shared.module';
import { CreditReportingController } from './credit-reporting.controller';
import { CreditReportingService } from './credit-reporting.service';

@Module({
  imports: [CreditCoreModule],
  controllers: [CreditReportingController],
  providers: [CreditReportingService],
  exports: [CreditReportingService],
})
export class CreditReportingModule {}
