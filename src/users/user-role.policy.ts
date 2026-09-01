import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { UserRole } from './entities/user.entity';

export const SELF_SERVICE_USER_ROLES = [
  UserRole.DRIVER,
  UserRole.PASSENGER,
] as const;

export type SelfServiceUserRole = (typeof SELF_SERVICE_USER_ROLES)[number];

export const ADMIN_USER_ROLES = [
  UserRole.ADMIN,
  UserRole.SUPER_ADMIN,
] as const;

export type AdminUserRole = (typeof ADMIN_USER_ROLES)[number];

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
      "Ce role ne peut pas etre attribue par l'inscription ou le profil utilisateur",
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
