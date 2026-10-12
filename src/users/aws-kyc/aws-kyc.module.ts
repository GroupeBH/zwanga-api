import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { KycEvidenceModule } from '../kyc-evidence/kyc-evidence.module';
import { AwsKycController } from './aws-kyc.controller';
import { AwsKycRepository } from './aws-kyc.repository';
import { AwsKycService } from './aws-kyc.service';
import { AwsKycTransport } from './aws-kyc.transport';
@Module({
  imports: [ConfigModule, KycEvidenceModule],
  controllers: [AwsKycController],
  providers: [AwsKycRepository, AwsKycService, AwsKycTransport],
})
export class AwsKycModule {}
