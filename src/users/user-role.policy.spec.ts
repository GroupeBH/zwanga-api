import { BadRequestException } from '@nestjs/common';
import { UserRole } from './entities/user.entity';
import {
  ADMIN_USER_ROLES,
  assertAdminRole,
  assertSelfServiceUserRole,
  assertSuperAdminRole,
  isAdminRole,
  normalizeUserDriverFlags,
  resolveSelfServiceDriverState,
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
    expect(ADMIN_USER_ROLES).toEqual([UserRole.ADMIN, UserRole.SUPER_ADMIN]);
    expect(isAdminRole(UserRole.ADMIN)).toBe(true);
    expect(isAdminRole(UserRole.SUPER_ADMIN)).toBe(true);
    expect(isSuperAdminRole(UserRole.ADMIN)).toBe(false);
    expect(isSuperAdminRole(UserRole.SUPER_ADMIN)).toBe(true);
    expect(roleHasAccess(UserRole.SUPER_ADMIN, UserRole.ADMIN)).toBe(true);
    expect(roleHasAccess(UserRole.ADMIN, UserRole.SUPER_ADMIN)).toBe(false);
    expect(() => assertAdminRole(UserRole.SUPER_ADMIN)).not.toThrow();
    expect(() => assertSuperAdminRole(UserRole.ADMIN)).toThrow();
  });

  it('normalizes legacy role/isDriver combinations from mobile clients', () => {
    expect(
      resolveSelfServiceDriverState({
        role: UserRole.PASSENGER,
        isDriver: true,
      }),
    ).toEqual({ role: UserRole.DRIVER, isDriver: true });

    expect(
      resolveSelfServiceDriverState({
        role: UserRole.DRIVER,
        isDriver: false,
      }),
    ).toEqual({ role: UserRole.DRIVER, isDriver: true });

    expect(
      resolveSelfServiceDriverState({
        role: UserRole.PASSENGER,
        hasVehicle: true,
      }),
    ).toEqual({ role: UserRole.DRIVER, isDriver: true });

    expect(resolveSelfServiceDriverState({ role: UserRole.PASSENGER })).toEqual(
      { role: UserRole.PASSENGER, isDriver: false },
    );
  });

  it('normalizes persisted users without letting admins become drivers', () => {
    const driver = { role: UserRole.DRIVER, isDriver: false };
    expect(normalizeUserDriverFlags(driver)).toBe(true);
    expect(driver).toEqual({ role: UserRole.DRIVER, isDriver: true });

    const passengerWithVehicle = {
      role: UserRole.PASSENGER,
      isDriver: false,
    };
    expect(
      normalizeUserDriverFlags(passengerWithVehicle, {
        hasActiveVehicle: true,
      }),
    ).toBe(true);
    expect(passengerWithVehicle).toEqual({
      role: UserRole.DRIVER,
      isDriver: true,
    });

    const admin = { role: UserRole.ADMIN, isDriver: true };
    expect(normalizeUserDriverFlags(admin)).toBe(true);
    expect(admin).toEqual({ role: UserRole.ADMIN, isDriver: false });
  });
});
