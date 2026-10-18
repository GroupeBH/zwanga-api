import type { Repository } from 'typeorm';
import { KycDocument, KycStatus } from './entities/kyc-document.entity';
import { LATEST_IDENTITY_ORDER } from './profile-state';

/** Never authorize from an approved historical dossier superseded by another. */
export async function hasCurrentApprovedIdentity(
  repository: Pick<Repository<KycDocument>, 'findOne'>, userId: string,
): Promise<boolean> {
  const latest = await repository.findOne({ where: { userId }, order: LATEST_IDENTITY_ORDER,
    select: { id: true, status: true } });
  return latest?.status === KycStatus.APPROVED;
}
