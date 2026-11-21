import { Module } from '@nestjs/common';
import { CreditCoreModule } from '../shared/credit-shared.module';
import { CreditEvidenceController } from './credit-evidence.controller';
import { CreditEvidenceService } from './credit-evidence.service';

@Module({
  imports: [CreditCoreModule],
  controllers: [CreditEvidenceController],
  providers: [CreditEvidenceService],
  exports: [CreditEvidenceService],
})
export class CreditEvidenceModule {}
