import type { EntityManager } from 'typeorm';
import { User, UserRole, UserStatus } from './entities/user.entity';
import { KycDocument, KycStatus } from './entities/kyc-document.entity';
import { Vehicle } from '../vehicles/entities/vehicle.entity';
import { LATEST_IDENTITY_ORDER } from './profile-state';
import { isAdminRole } from './user-role.policy';

/** Internal approval hook shared by admin, authenticated Didit callbacks and AWS.
 * Runs in the decision transaction, not over HTTP and not from a phone assertion.
 * A failed role update rolls back the decision and its notification together.
 * Callers lock the user before saving KYC; this lock is re-entrant in that transaction.
 */
export async function applyKycApprovalHook(
  manager: EntityManager,
  kyc: KycDocument,
): Promise<User | null> {
  if (kyc.status !== KycStatus.APPROVED || !kyc.userId) return null;
  if (!manager.queryRunner?.isTransactionActive)
    throw new Error('KYC approval hook requires a transaction');
  const users = manager.getRepository(User);
  const user = await users.findOne({
    where: { id: kyc.userId },
    lock: { mode: 'pessimistic_write' },
    select: {
      id: true,
      role: true,
      isActive: true,
      status: true,
      isDriver: true,
      driverOnboardingRequestedAt: true,
      driverActivatedAt: true,
    },
  });
  if (!user) return null;
  const latest = await manager.getRepository(KycDocument).findOne({
    where: { userId: user.id },
    order: LATEST_IDENTITY_ORDER,
    select: { id: true, status: true },
  });
  if (latest?.id !== kyc.id || latest.status !== KycStatus.APPROVED)
    return null;
  if (
    isAdminRole(user.role) ||
    !user.isActive ||
    [UserStatus.SUSPENDED, UserStatus.INACTIVE].includes(user.status)
  )
    return user;

  const patch: Partial<Pick<User, 'status' | 'role' | 'isDriver' | 'driverOnboardingRequestedAt' | 'driverActivatedAt'>> = {};
  if (user.status !== UserStatus.ACTIVE) patch.status = UserStatus.ACTIVE;
  // A pre-existing active owned vehicle now suffices on a NEW approval. Read-only
  // profile requests still never promote accounts, and legacy drivers are preserved.
  if (
    user.role === UserRole.PASSENGER &&
    (await manager
      .getRepository(Vehicle)
      .exists({ where: { ownerId: user.id, isActive: true } }))
  ) {
    Object.assign(patch, {
      role: UserRole.DRIVER,
      isDriver: true,
      driverOnboardingRequestedAt:
        user.driverOnboardingRequestedAt ?? new Date(),
      driverActivatedAt: user.driverActivatedAt ?? new Date(),
    });
  }
  if (Object.keys(patch).length) await users.update(user.id, patch);
  return Object.assign(user, patch);
}
