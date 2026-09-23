import { BadRequestException } from '@nestjs/common';
import { KycStatus } from '../../users/entities/kyc-document.entity';

export function parseKycStatus(
  status?: string | null,
): KycStatus | undefined {
  if (!status || status === 'all') {
    return undefined;
  }

  if (Object.values(KycStatus).includes(status as KycStatus)) {
    return status as KycStatus;
  }

  throw new BadRequestException(
    'Le statut KYC doit être pending, approved ou rejected',
  );
}
