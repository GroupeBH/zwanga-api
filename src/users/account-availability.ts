import { ForbiddenException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { User, UserStatus } from './entities/user.entity';

// Only trusted SQL expressions, never identifiers supplied by the client.
export const availableAccountSql = (id: string) => `EXISTS (SELECT 1 FROM users account_owner
  WHERE account_owner.id = (${id})::uuid AND account_owner."isActive" = true
    AND account_owner.status NOT IN ('inactive', 'suspended'))`;

export function assertAccountAvailable(user: Pick<User, 'isActive' | 'status'> | null) {
  if (!user || !user.isActive || [UserStatus.INACTIVE, UserStatus.SUSPENDED].includes(user.status))
    throw new ForbiddenException({ code: 'ACCOUNT_UNAVAILABLE', message: 'Ce compte est désactivé ou supprimé.' });
}

/** Take BEFORE request/trip/booking locks when creating a new resource. */
export async function lockAvailableAccounts(manager: EntityManager, ids: string[]) {
  for (const id of [...new Set(ids)].sort()) {
    const user = await manager.findOne(User, { where: { id },
      select: ['id', 'isActive', 'status'], lock: { mode: 'for_no_key_update' } });
    assertAccountAvailable(user);
  }
}
