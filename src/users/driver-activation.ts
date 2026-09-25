import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { User, UserRole, UserStatus } from './entities/user.entity';
import { KycDocument, KycStatus } from './entities/kyc-document.entity';
import { Vehicle } from '../vehicles/entities/vehicle.entity';
import { isAdminRole } from './user-role.policy';

export async function driverRequirements(manager: EntityManager, userId: string) {
  const latestIdentity = await manager.getRepository(KycDocument).findOne({
    where: { userId }, order: { createdAt: 'DESC', id: 'DESC' },
    select: { id: true, status: true },
  });
  const hasVehicle = await manager.getRepository(Vehicle).exists({
    where: { ownerId: userId, isActive: true },
  });
  return { identityApproved: latestIdentity?.status === KycStatus.APPROVED, hasVehicle };
}

function assertRequirements(requirements: Awaited<ReturnType<typeof driverRequirements>>) {
  if (!requirements.identityApproved) {
    throw new BadRequestException({ code: 'DRIVER_IDENTITY_REQUIRED',
      message: 'Votre identité doit être approuvée avant l’activation conducteur.' });
  }
  if (!requirements.hasVehicle) {
    throw new BadRequestException({ code: 'TRIP_ACTIVE_VEHICLE_REQUIRED',
      message: 'Ajoutez un véhicule actif vous appartenant pour devenir conducteur.' });
  }
}

// Caller owns a short transaction. Always lock the user first (also used by Didit).
// No external network call or automatic migration of existing users.
export async function activateRequestedDriver(
  manager: EntityManager,
  userId: string,
  options: { request?: boolean; requireReady?: boolean } = {},
): Promise<User> {
  const users = manager.getRepository(User);
  const user = await users.findOne({ where: { id: userId }, lock: { mode: 'pessimistic_write' } });
  if (!user) throw new NotFoundException('Utilisateur introuvable');
  if (isAdminRole(user.role) || !user.isActive || user.status === UserStatus.SUSPENDED || user.status === UserStatus.INACTIVE) {
    if (options.request) throw new ForbiddenException('Ce compte ne peut pas activer le profil conducteur.');
    return user;
  }
  if (user.role === UserRole.DRIVER) return user; // Idempotent; preserve legacy drivers.
  if (!options.request && !user.driverOnboardingRequestedAt) return user;

  const requirements = await driverRequirements(manager, userId);
  if (options.requireReady) assertRequirements(requirements);
  const requestedAt = user.driverOnboardingRequestedAt ?? new Date();
  const ready = requirements.identityApproved && requirements.hasVehicle;
  const patch: Partial<Pick<User, 'role' | 'isDriver' | 'driverOnboardingRequestedAt' | 'driverActivatedAt'>> = {
    driverOnboardingRequestedAt: requestedAt,
    ...(ready ? { role: UserRole.DRIVER, isDriver: true, driverActivatedAt: new Date() } : {}),
  };
  if (!user.driverOnboardingRequestedAt || ready) await users.update(userId, patch);
  return Object.assign(user, patch);
}

// Authorization reads never activate a user. This is separate from participation
// in an existing trip: bookings, cash receipts, balances and history stay intact.
export async function assertDriverCanOperate(manager: EntityManager, user: User) {
  if (user.role !== UserRole.DRIVER) {
    throw new ForbiddenException({ code: 'DRIVER_PROFILE_REQUIRED',
      message: 'Terminez le parcours Devenir conducteur avant cette action.' });
  }
  if (!user.isActive || user.status === UserStatus.SUSPENDED || user.status === UserStatus.INACTIVE) {
    throw new ForbiddenException('Votre compte ne peut pas proposer de nouveaux trajets.');
  }
  assertRequirements(await driverRequirements(manager, user.id));
}
