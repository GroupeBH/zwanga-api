import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { UserRole } from './entities/user.entity';

export const SELF_SERVICE_USER_ROLES = [
  UserRole.DRIVER,
  UserRole.PASSENGER,
] as const;

export type SelfServiceUserRole = (typeof SELF_SERVICE_USER_ROLES)[number];

export const ADMIN_USER_ROLES = [UserRole.ADMIN, UserRole.SUPER_ADMIN] as const;

export type AdminUserRole = (typeof ADMIN_USER_ROLES)[number];

type DriverRoleResolutionInput = {
  role?: SelfServiceUserRole | null;
  isDriver?: boolean | null;
  hasVehicle?: boolean;
  defaultRole?: SelfServiceUserRole;
};

type DriverFlagCarrier = {
  role: UserRole;
  isDriver: boolean;
};

export function isSelfServiceUserRole(
  role: unknown,
): role is SelfServiceUserRole {
  return SELF_SERVICE_USER_ROLES.some((allowedRole) => allowedRole === role);
}

export function isAdminRole(role: unknown): role is AdminUserRole {
  return ADMIN_USER_ROLES.some((allowedRole) => allowedRole === role);
}

export function isSuperAdminRole(role: unknown): role is UserRole.SUPER_ADMIN {
  return role === UserRole.SUPER_ADMIN;
}

/**
 * Public mobile flows historically sent both `role` and `isDriver`.
 * They are the same business decision, so the backend must never persist
 * contradictory values such as `role=driver/isDriver=false`.
 */
export function resolveSelfServiceDriverState({
  role,
  isDriver,
  hasVehicle = false,
  defaultRole = UserRole.PASSENGER,
}: DriverRoleResolutionInput): {
  role: SelfServiceUserRole;
  isDriver: boolean;
} {
  const requestedRole = role ?? defaultRole;
  assertSelfServiceUserRole(requestedRole);

  const wantsDriver =
    requestedRole === UserRole.DRIVER || isDriver === true || hasVehicle;

  return wantsDriver
    ? { role: UserRole.DRIVER, isDriver: true }
    : { role: UserRole.PASSENGER, isDriver: false };
}

export function normalizeUserDriverFlags(
  user: DriverFlagCarrier,
  options: { hasActiveVehicle?: boolean } = {},
): boolean {
  const currentRole = user.role;
  const currentIsDriver = user.isDriver;

  if (isAdminRole(user.role)) {
    user.isDriver = false;
    return currentIsDriver !== user.isDriver;
  }

  const wantsDriver =
    user.role === UserRole.DRIVER ||
    user.isDriver === true ||
    options.hasActiveVehicle === true;

  user.role = wantsDriver ? UserRole.DRIVER : UserRole.PASSENGER;
  user.isDriver = wantsDriver;

  return currentRole !== user.role || currentIsDriver !== user.isDriver;
}

export function roleHasAccess(
  actualRole: unknown,
  requiredRole: UserRole,
): boolean {
  if (requiredRole === UserRole.ADMIN) {
    return isAdminRole(actualRole);
  }

  return actualRole === requiredRole;
}

/**
 * Privileged roles must never be assigned by a public or self-service flow.
 */
export function assertSelfServiceUserRole(
  role: unknown,
): asserts role is SelfServiceUserRole {
  if (!isSelfServiceUserRole(role)) {
    throw new BadRequestException(
      "Ce rôle ne peut pas être attribué par l'inscription ou le profil utilisateur",
    );
  }
}

export function assertAdminRole(
  role: unknown,
  message = 'Action reservee aux administrateurs',
): asserts role is AdminUserRole {
  if (!isAdminRole(role)) {
    throw new ForbiddenException(message);
  }
}

export function assertSuperAdminRole(
  role: unknown,
  message = 'Action reservee au super administrateur',
): asserts role is UserRole.SUPER_ADMIN {
  if (!isSuperAdminRole(role)) {
    throw new ForbiddenException(message);
  }
}
