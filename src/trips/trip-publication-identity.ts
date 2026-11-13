import { BadRequestException } from '@nestjs/common';
import type { Repository } from 'typeorm';
import { KycDocument, KycStatus } from '../users/entities/kyc-document.entity';
import { LATEST_IDENTITY_ORDER } from '../users/profile-state';

/** Never accept an older approval when the newest identity is pending/rejected. */
export async function assertDriverPublicationIdentity(
  identities: Repository<KycDocument>,
  driverId: string,
): Promise<void> {
  const latest = await identities.findOne({
    where: { userId: driverId },
    order: LATEST_IDENTITY_ORDER,
    select: ['id', 'status'],
  });
  if (!latest || latest.status !== KycStatus.APPROVED) {
    throw new BadRequestException({
      error: 'Vérification d’identité du conducteur requise',
      code: 'DRIVER_KYC_NOT_APPROVED',
      message:
        'L’identité du conducteur doit être approuvée avant de publier ce trajet.',
    });
  }
}
