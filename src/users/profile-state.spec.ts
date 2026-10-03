import { buildProfileState, LATEST_IDENTITY_ORDER } from './profile-state';
import {
  KycDocument,
  KycProvider,
  KycStatus,
} from './entities/kyc-document.entity';
import { User, UserRole, UserStatus } from './entities/user.entity';
import { UsersService } from './users.service';
import { assertDriverCanOperate } from './driver-activation';
import type { EntityManager } from 'typeorm';

function account(overrides: Partial<User> = {}): User {
  return {
    id: 'account',
    role: UserRole.PASSENGER,
    isActive: true,
    status: UserStatus.ACTIVE,
    driverOnboardingRequestedAt: null,
    vehicles: [],
    kycDocuments: [],
    ...overrides,
  } as User;
}
const approved = { id: 'identity', status: KycStatus.APPROVED } as KycDocument;
const vehicle = {
  id: 'vehicle',
  ownerId: 'account',
  isActive: true,
} as User['vehicles'][number];

describe('server-owned profile journey', () => {
  it('does not promote a passenger with identity and vehicle but no explicit intent', () => {
    const user = account({
      isDriver: true,
      vehicles: [vehicle],
      kycDocuments: [approved],
    });
    const result = buildProfileState(user);
    expect(result.driver).toMatchObject({
      status: 'not_requested',
      nextAction: 'start',
      canPublish: false,
    });
    expect(user.role).toBe(UserRole.PASSENGER);
    expect(user.driverOnboardingRequestedAt).toBeNull();
  });
  it.each([
    [undefined, 0, 'identity_required', 'verify_identity'],
    [KycStatus.REJECTED, 1, 'identity_required', 'verify_identity'],
    [KycStatus.PENDING, 0, 'vehicle_required', 'add_vehicle'],
    [KycStatus.PENDING, 1, 'identity_pending', 'wait'],
    [KycStatus.APPROVED, 0, 'vehicle_required', 'add_vehicle'],
    [KycStatus.APPROVED, 1, 'ready_to_activate', 'activate'],
  ])(
    'selects a single next action: %s, vehicles=%s',
    (identity, count, status, nextAction) => {
      const user = account({
        driverOnboardingRequestedAt: new Date(),
        kycDocuments: identity ? [{ ...approved, status: identity }] : [],
        vehicles: count ? [vehicle] : [],
      });
      expect(buildProfileState(user).driver).toMatchObject({
        status,
        nextAction,
        canPublish: false,
      });
    },
  );
  it('a Didit session not yet started is not a submission under review', () => {
    const user = account({
      role: UserRole.DRIVER,
      vehicles: [vehicle],
      kycDocuments: [
        {
          ...approved,
          status: KycStatus.PENDING,
          provider: KycProvider.DIDIT,
          diditSessionStatus: 'Not Started',
        },
      ],
    });
    expect(buildProfileState(user)).toMatchObject({
      identity: { status: 'not_started' },
      driver: { nextAction: 'verify_identity' },
    });
  });
  it('counts only active owned vehicles and never changes legacy driver roles', () => {
    const user = account({
      role: UserRole.DRIVER,
      kycDocuments: [approved],
      vehicles: [
        { ...vehicle, isActive: false },
        { ...vehicle, ownerId: 'someone-else' },
      ],
    });
    expect(buildProfileState(user).driver).toMatchObject({
      activeVehicleCount: 0,
      status: 'vehicle_required',
      canPublish: false,
    });
    expect(user.role).toBe(UserRole.DRIVER);
  });
  it.each([
    { role: UserRole.ADMIN },
    { role: UserRole.SUPER_ADMIN },
    { isActive: false },
    { status: UserStatus.SUSPENDED },
    { status: UserStatus.INACTIVE },
  ])('restricts protected/ineligible accounts: %j', (overrides) => {
    const user = account({
      role: UserRole.DRIVER,
      vehicles: [vehicle],
      kycDocuments: [approved],
      ...overrides,
    });
    expect(buildProfileState(user).driver).toMatchObject({
      status: 'restricted',
      nextAction: 'contact_support',
      canPublish: false,
    });
  });
  it('latest createdAt then id wins, without exposing document files or changing their order', () => {
    const first = { ...approved, createdAt: new Date('2026-09-20') };
    const latest = {
      ...approved,
      id: 'z',
      status: KycStatus.REJECTED,
      createdAt: new Date('2026-09-21'),
      rejectionReason: 'À reprendre',
    };
    const user = account({
      role: UserRole.DRIVER,
      vehicles: [vehicle],
      kycDocuments: [
        first,
        latest,
        { ...latest, id: 'a', status: KycStatus.APPROVED },
      ],
    });
    const result = buildProfileState(user);
    expect(result.identity).toEqual({
      status: 'rejected',
      rejectionReason: 'À reprendre',
    });
    expect(user.kycDocuments[0]).toBe(first);
  });
  it.each([UserRole.PASSENGER, UserRole.DRIVER])(
    'publication eligibility matches the authorization guard for %s',
    async (role) => {
      for (const status of [
        KycStatus.APPROVED,
        KycStatus.PENDING,
        KycStatus.REJECTED,
      ]) {
        for (const active of [true, false]) {
          const user = account({
            role,
            kycDocuments: [{ ...approved, status }],
            vehicles: [{ ...vehicle, isActive: active }],
          });
          const manager = {
            getRepository: (entity: unknown) =>
              entity === KycDocument
                ? { findOne: () => Promise.resolve(user.kycDocuments[0]) }
                : { exists: () => Promise.resolve(active) },
          } as unknown as EntityManager;
          let allowed = true;
          try {
            await assertDriverCanOperate(manager, user);
          } catch {
            allowed = false;
          }
          expect(buildProfileState(user).driver.canPublish).toBe(allowed);
        }
      }
    },
  );
});

describe('profile endpoint contract', () => {
  it('returns profileState alongside the unchanged user/stats contract without a database write', async () => {
    const user = account({
      role: UserRole.DRIVER,
      vehicles: [vehicle],
      kycDocuments: [approved],
    });
    const service = {
      findOne: jest.fn().mockResolvedValue(user),
      tripRepository: { count: jest.fn().mockResolvedValue(2) },
      bookingRepository: {
        count: jest.fn().mockResolvedValue(1),
        createQueryBuilder: () => ({
          innerJoin: () => ({
            where: () => ({ getCount: () => Promise.resolve(3) }),
          }),
        }),
      },
      messageRepository: { count: jest.fn().mockResolvedValue(0) },
      enrichUserWithPresignedUrls: (value: User) => Promise.resolve(value),
      toSafeUser: (value: User) => value,
      subscriptionsService: {
        getPremiumOverview: () =>
          Promise.resolve({
            isPremium: false,
            premiumBadgeEnabled: false,
          }),
      },
    } as unknown as UsersService;
    const result = (await UsersService.prototype.getProfileSummary.call(
      service,
      user.id,
    )) as Awaited<ReturnType<UsersService['getProfileSummary']>>;
    expect(result.profileState).toMatchObject({
      version: 1,
      userId: user.id,
      driver: { status: 'active', nextAction: 'none', canPublish: true },
    });
    expect(result.stats).toMatchObject({
      vehicles: 1,
      tripsAsDriver: 2,
      bookingsAsDriver: 3,
    });
    expect(result.user.role).toBe(UserRole.DRIVER);
  });
  it('KYC status uses the same deterministic identity order as activation', async () => {
    const findOne = jest.fn().mockResolvedValue(null);
    const service = {
      kycDocumentRepository: { findOne },
      logger: { log: jest.fn() },
    } as unknown as UsersService;
    expect(
      await UsersService.prototype.getKycStatus.call(service, 'account'),
    ).toBeNull();
    expect(findOne).toHaveBeenCalledWith({
      where: { userId: 'account' },
      order: LATEST_IDENTITY_ORDER,
    });
  });
});
