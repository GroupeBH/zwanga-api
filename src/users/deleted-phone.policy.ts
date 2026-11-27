import { ConflictException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { canonicalAccountPhone } from './phone-identity';

export const DELETED_PHONE_MESSAGE =
  'Ce numéro de téléphone était associé à un compte supprimé. Il ne peut plus être utilisé pour créer un nouveau compte.';

/** Early feedback only; the database trigger is the final, concurrent write guard. */
export async function assertPhoneNotDeleted(
  manager: Pick<EntityManager, 'query'>,
  phone: string,
): Promise<void> {
  const rows: { deleted: boolean }[] = await manager.query(
    `SELECT true AS deleted FROM public.user_phone_identities
     WHERE phone = $1 AND "deletedAt" IS NOT NULL`,
    [canonicalAccountPhone(phone)],
  );
  if (rows.length) {
    throw new ConflictException({
      code: 'PHONE_PREVIOUSLY_DELETED',
      message: DELETED_PHONE_MESSAGE,
    });
  }
}
