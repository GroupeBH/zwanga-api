import { KycStatus } from '../users/entities/kyc-document.entity';
import { UserRole } from '../users/entities/user.entity';
import {
  ACTIVE_VEHICLE_EXISTS,
  applyAdminUserSegmentFilter,
  APPROVED_KYC_EXISTS,
  QUALIFIED_DRIVER_CONDITION,
  resolveDriverQualification,
} from './qualified-driver';

describe('qualified driver policy', () => {
  it('requires isDriver, an approved KYC and an active vehicle', () => {
    expect(
      resolveDriverQualification({
        role: UserRole.DRIVER,
        isDriver: true,
        hasApprovedKyc: true,
        hasActiveVehicle: true,
      }).isQualifiedDriver,
    ).toBe(true);

    expect(
      resolveDriverQualification({
        role: UserRole.DRIVER,
        isDriver: false,
        hasApprovedKyc: true,
        hasActiveVehicle: true,
      }).isQualifiedDriver,
    ).toBe(false);

    expect(
      resolveDriverQualification({
        role: UserRole.DRIVER,
        isDriver: true,
        hasApprovedKyc: true,
        hasActiveVehicle: false,
      }).isQualifiedDriver,
    ).toBe(false);

    expect(
      resolveDriverQualification({
        role: UserRole.ADMIN,
        isDriver: true,
        hasApprovedKyc: true,
        hasActiveVehicle: true,
      }).isQualifiedDriver,
    ).toBe(false);
  });

  it('filters drivers, passengers without KYC, and KYC passengers without a vehicle', () => {
    const query = {
      andWhere: jest.fn(),
    };
    query.andWhere.mockReturnValue(query);

    applyAdminUserSegmentFilter(query as any, 'driver');
    expect(query.andWhere).toHaveBeenCalledWith(
      'user.role NOT IN (:...adminRoles)',
      expect.objectContaining({ adminRoles: expect.any(Array) }),
    );
    expect(query.andWhere).toHaveBeenCalledWith(
      QUALIFIED_DRIVER_CONDITION('user'),
      expect.objectContaining({ approvedKycStatus: KycStatus.APPROVED }),
    );
    expect(QUALIFIED_DRIVER_CONDITION('user')).toContain('"user"."isDriver"');
    expect(APPROVED_KYC_EXISTS('user')).toContain('"user".id');

    query.andWhere.mockClear();
    applyAdminUserSegmentFilter(query as any, 'passenger');
    expect(query.andWhere).toHaveBeenCalledWith(
      `NOT ${APPROVED_KYC_EXISTS('user')}`,
      expect.objectContaining({ approvedKycStatus: KycStatus.APPROVED }),
    );

    query.andWhere.mockClear();
    applyAdminUserSegmentFilter(query as any, 'verified_passenger');
    expect(query.andWhere).toHaveBeenCalledWith(
      APPROVED_KYC_EXISTS('user'),
      expect.objectContaining({ approvedKycStatus: KycStatus.APPROVED }),
    );
    expect(query.andWhere).toHaveBeenCalledWith(
      `NOT ${ACTIVE_VEHICLE_EXISTS('user')}`,
    );
  });
});
