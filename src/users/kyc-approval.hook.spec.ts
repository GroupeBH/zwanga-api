import type { EntityManager } from 'typeorm';
import { applyKycApprovalHook } from './kyc-approval.hook';
import { User, UserRole, UserStatus } from './entities/user.entity';
import { KycDocument, KycStatus } from './entities/kyc-document.entity';

const fixture = (overrides: Partial<User> = {}, hasVehicle = true) => {
  const user = {
    id: 'user',
    role: UserRole.PASSENGER,
    isActive: true,
    isDriver: false,
    status: UserStatus.PENDING_KYC,
    driverOnboardingRequestedAt: null,
    driverActivatedAt: null,
    ...overrides,
  } as User;
  const kyc = {
    id: 'kyc',
    userId: 'user',
    status: KycStatus.APPROVED,
  } as KycDocument;
  const users = {
    findOne: jest.fn().mockResolvedValue(user),
    update: jest.fn(async (_id, patch) => Object.assign(user, patch)),
  };
  const documents = { findOne: jest.fn().mockResolvedValue(kyc) };
  const vehicles = { exists: jest.fn().mockResolvedValue(hasVehicle) };
  const manager = {
    queryRunner: { isTransactionActive: true },
    getRepository: (entity) =>
      entity === User ? users : entity === KycDocument ? documents : vehicles,
  } as unknown as EntityManager;
  return { user, kyc, users, documents, vehicles, manager };
};
describe('internal KYC approval hook', () => {
  it('activates an owner of an active vehicle, even without earlier driver intent, exactly once', async () => {
    const f = fixture();
    await applyKycApprovalHook(f.manager, f.kyc);
    expect(f.user).toMatchObject({
      role: UserRole.DRIVER,
      isDriver: true,
      status: UserStatus.ACTIVE,
      driverOnboardingRequestedAt: expect.any(Date),
      driverActivatedAt: expect.any(Date),
    });
    expect(f.vehicles.exists).toHaveBeenCalledWith({
      where: { ownerId: 'user', isActive: true },
    });
    const activatedAt = f.user.driverActivatedAt;
    await applyKycApprovalHook(f.manager, f.kyc);
    expect(f.users.update).toHaveBeenCalledTimes(1);
    expect(f.user.driverActivatedAt).toBe(activatedAt);
  });
  it('validates a passenger without inventing driver intent when no active vehicle exists', async () => {
    const f = fixture({}, false);
    await applyKycApprovalHook(f.manager, f.kyc);
    expect(f.users.update).toHaveBeenCalledWith('user', {
      status: UserStatus.ACTIVE,
    });
    expect(f.user.role).toBe(UserRole.PASSENGER);
    expect(f.user.driverOnboardingRequestedAt).toBeNull();
  });
  it.each([
    { role: UserRole.ADMIN },
    { role: UserRole.SUPER_ADMIN },
    { isActive: false },
    { status: UserStatus.SUSPENDED },
    { status: UserStatus.INACTIVE },
  ])('does not change protected account %j', async (overrides) => {
    const f = fixture(overrides);
    await applyKycApprovalHook(f.manager, f.kyc);
    expect(f.users.update).not.toHaveBeenCalled();
    expect(f.vehicles.exists).not.toHaveBeenCalled();
  });
  it('does not demote a driver who no longer has an active vehicle', async () => {
    const f = fixture(
      { role: UserRole.DRIVER, isDriver: true, status: UserStatus.ACTIVE },
      false,
    );
    await applyKycApprovalHook(f.manager, f.kyc);
    expect(f.users.update).not.toHaveBeenCalled();
  });
  it('ignores approval of an older dossier and all non-approvals', async () => {
    const f = fixture();
    f.documents.findOne.mockResolvedValue({ ...f.kyc, id: 'newer' });
    expect(await applyKycApprovalHook(f.manager, f.kyc)).toBeNull();
    for (const status of [KycStatus.PENDING, KycStatus.REJECTED])
      expect(
        await applyKycApprovalHook(f.manager, { ...f.kyc, status }),
      ).toBeNull();
    expect(f.users.update).not.toHaveBeenCalled();
  });
  it('refuses non-transactional calls and propagates failures instead of losing activation', async () => {
    const f = fixture();
    f.users.update.mockRejectedValue(new Error('db unavailable'));
    await expect(applyKycApprovalHook(f.manager, f.kyc)).rejects.toThrow(
      'db unavailable',
    );
    f.manager.queryRunner!.isTransactionActive = false;
    await expect(applyKycApprovalHook(f.manager, f.kyc)).rejects.toThrow(
      'requires a transaction',
    );
  });
});
