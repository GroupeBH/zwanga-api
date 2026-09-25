import { SelectQueryBuilder } from 'typeorm';
import { KycStatus } from '../users/entities/kyc-document.entity';
import { UserRole } from '../users/entities/user.entity';
import { ADMIN_USER_ROLES, isAdminRole } from '../users/user-role.policy';
import { AdminUserSegment } from './dto/admin-users.dto';

export type DriverQualification = {
  hasApprovedKyc: boolean;
  hasActiveVehicle: boolean;
  isQualifiedDriver: boolean;
};

const quoteIdent = (identifier: string) =>
  `"${identifier.replaceAll('"', '')}"`;

const adminRoleParams = {
  adminRoles: [...ADMIN_USER_ROLES],
};

const approvedKycParams = {
  approvedKycStatus: KycStatus.APPROVED,
};

export const APPROVED_KYC_EXISTS = (alias: string) =>
  `EXISTS (
    SELECT 1
    FROM kyc_documents kyc
    WHERE kyc."userId" = ${quoteIdent(alias)}.id
      AND kyc.status = :approvedKycStatus
  )`;

export const ACTIVE_VEHICLE_EXISTS = (alias: string) =>
  `EXISTS (
    SELECT 1
    FROM vehicles vehicle
    WHERE vehicle."ownerId" = ${quoteIdent(alias)}.id
      AND vehicle."isActive" IS TRUE
  )`;

export const QUALIFIED_DRIVER_CONDITION = (alias: string) =>
  `(
    ${quoteIdent(alias)}."role" = 'driver'
    AND ${APPROVED_KYC_EXISTS(alias)}
    AND ${ACTIVE_VEHICLE_EXISTS(alias)}
  )`;

export function applyAdminUserSegmentFilter<T extends object>(
  query: SelectQueryBuilder<T>,
  segment: AdminUserSegment,
  alias = 'user',
): SelectQueryBuilder<T> {
  query.andWhere(`${alias}.role NOT IN (:...adminRoles)`, adminRoleParams);

  if (segment === 'driver') {
    return query.andWhere(
      QUALIFIED_DRIVER_CONDITION(alias),
      approvedKycParams,
    );
  }

  if (segment === 'passenger') {
    return query.andWhere(
      `NOT ${APPROVED_KYC_EXISTS(alias)}`,
      approvedKycParams,
    );
  }

  return query
    .andWhere(APPROVED_KYC_EXISTS(alias), approvedKycParams)
    .andWhere(`NOT ${ACTIVE_VEHICLE_EXISTS(alias)}`);
}

export function resolveDriverQualification(input: {
  role?: string | null;
  isDriver?: boolean | null;
  hasApprovedKyc: boolean;
  hasActiveVehicle: boolean;
}): DriverQualification {
  const hasApprovedKyc = Boolean(input.hasApprovedKyc);
  const hasActiveVehicle = Boolean(input.hasActiveVehicle);

  return {
    hasApprovedKyc,
    hasActiveVehicle,
    isQualifiedDriver:
      input.role === UserRole.DRIVER &&
      hasApprovedKyc &&
      hasActiveVehicle &&
      !isAdminRole(input.role),
  };
}
