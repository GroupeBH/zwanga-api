import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { KycEvidenceRepository } from './kyc-evidence.repository';
import { KycEvidenceService } from './kyc-evidence.service';
import { KycEvidenceStorage } from './kyc-evidence.storage';
import { KycEvidenceTransport } from './kyc-evidence.transport';
import { KycEvidenceController } from './kyc-evidence.controller';

@Module({
  imports: [ConfigModule],
  controllers: [KycEvidenceController],
  providers: [
    KycEvidenceRepository,
    KycEvidenceService,
    KycEvidenceStorage,
    KycEvidenceTransport,
  ],
  exports: [KycEvidenceRepository],
})
export class KycEvidenceModule {}
