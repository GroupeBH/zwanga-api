import { BadRequestException } from '@nestjs/common';
import { UserRole } from './entities/user.entity';
import {
  ADMIN_USER_ROLES,
  assertAdminRole,
  assertSelfServiceUserRole,
  assertSuperAdminRole,
  isAdminRole,
  isSelfServiceUserRole,
  isSuperAdminRole,
  roleHasAccess,
  SELF_SERVICE_USER_ROLES,
} from './user-role.policy';

describe('self-service user role policy', () => {
  it('allows only driver and passenger roles', () => {
    expect(SELF_SERVICE_USER_ROLES).toEqual([
      UserRole.DRIVER,
      UserRole.PASSENGER,
    ]);
    expect(isSelfServiceUserRole(UserRole.DRIVER)).toBe(true);
    expect(isSelfServiceUserRole(UserRole.PASSENGER)).toBe(true);
  });

  it('rejects the admin role', () => {
    expect(isSelfServiceUserRole(UserRole.ADMIN)).toBe(false);
    expect(() => assertSelfServiceUserRole(UserRole.ADMIN)).toThrow(
      BadRequestException,
    );
    expect(isSelfServiceUserRole(UserRole.SUPER_ADMIN)).toBe(false);
    expect(() => assertSelfServiceUserRole(UserRole.SUPER_ADMIN)).toThrow(
      BadRequestException,
    );
  });

  it('treats super admins as admins and preserves super admin-only checks', () => {
    expect(ADMIN_USER_ROLES).toEqual([
      UserRole.ADMIN,
      UserRole.SUPER_ADMIN,
    ]);
    expect(isAdminRole(UserRole.ADMIN)).toBe(true);
    expect(isAdminRole(UserRole.SUPER_ADMIN)).toBe(true);
    expect(isSuperAdminRole(UserRole.ADMIN)).toBe(false);
    expect(isSuperAdminRole(UserRole.SUPER_ADMIN)).toBe(true);
    expect(roleHasAccess(UserRole.SUPER_ADMIN, UserRole.ADMIN)).toBe(true);
    expect(roleHasAccess(UserRole.ADMIN, UserRole.SUPER_ADMIN)).toBe(false);
    expect(() => assertAdminRole(UserRole.SUPER_ADMIN)).not.toThrow();
    expect(() => assertSuperAdminRole(UserRole.ADMIN)).toThrow();
  });
});
