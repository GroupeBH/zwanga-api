import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { AuthService } from '../auth/auth.service';
import { RegisterDto, GoogleMobileAuthDto, AppleMobileAuthDto } from '../auth/dto/auth.dto';
import { UpdateProfileDto } from './dto/user.dto';
import { UserRole, UserStatus } from './entities/user.entity';
import { DriverCategory, resolveDriverCategory } from './driver-category';
import { UsersService } from './users.service';
import { DriverCategory1780000120000 } from '../database/migrations/1780000120000-DriverCategory';

const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
const common = { phone: '+243000000000', firstName: 'Test', lastName: 'Example', role: UserRole.DRIVER };
const scenarios = [
  { dto: RegisterDto, body: { ...common, pin: '1234' } },
  { dto: GoogleMobileAuthDto, body: { ...common, idToken: 'test-only' } },
  { dto: AppleMobileAuthDto, body: { ...common, idToken: 'test-only' } },
  { dto: UpdateProfileDto, body: {} },
];

describe.each(scenarios)('$dto.name driver category contract', ({ dto, body }) => {
  it.each([undefined, null, DriverCategory.PRIVATE, DriverCategory.TRANSPORT])('accepts %s without making legacy clients mandatory', async driverCategory => {
    const result = await pipe.transform({ ...body, driverCategory }, { type: 'body', metatype: dto });
    expect(result.driverCategory).toBe(driverCategory);
  });
  it.each(['taxi', 'admin', '', {}, true])('rejects invalid category %j', async driverCategory => {
    await expect(pipe.transform({ ...body, driverCategory }, { type: 'body', metatype: dto }))
      .rejects.toBeInstanceOf(BadRequestException);
  });
});

function profileFixture(extra: object = {}) {
  const user = { id: 'test-account', role: UserRole.DRIVER, isDriver: true,
    status: UserStatus.ACTIVE, driverCategory: null, driverOnboardingRequestedAt: null, ...extra };
  const update = jest.fn(async (_id, changes) => Object.assign(user, changes));
  const service: UsersService = Object.assign(Object.create(UsersService.prototype), {
    userRepository: { update }, logger: { log() {}, warn() {} },
    findOne: async () => ({ ...user }), enrichUserWithPresignedUrls: async value => value,
  });
  return { user, update, service };
}

describe('driver category persistence and role isolation', () => {
  it('changes a legacy driver profile without changing its rights, status or vehicle', async () => {
    const f = profileFixture();
    for (const driverCategory of [DriverCategory.PRIVATE, DriverCategory.TRANSPORT]) {
      const result = await f.service.updateProfile(f.user.id, { driverCategory });
      expect(result.driverCategory).toBe(driverCategory);
      expect(result.role).toBe(UserRole.DRIVER);
      expect(result.isDriver).toBe(true);
      expect(result.status).toBe(UserStatus.ACTIVE);
    }
    await f.service.updateProfile(f.user.id, {});
    expect(f.user.driverCategory).toBe(DriverCategory.TRANSPORT);
    expect(f.update.mock.calls.at(-1)![1]).not.toHaveProperty('driverCategory');
    for (const [, changes] of f.update.mock.calls) {
      for (const key of ['role', 'isDriver', 'driverActivatedAt', 'status']) expect(changes).not.toHaveProperty(key);
    }
  });

  it('allows pending driver intent, but does not activate that account', async () => {
    const f = profileFixture({ role: UserRole.PASSENGER, isDriver: false, driverOnboardingRequestedAt: new Date() });
    await f.service.updateProfile(f.user.id, { driverCategory: DriverCategory.TRANSPORT });
    expect(f.user).toMatchObject({ role: UserRole.PASSENGER, isDriver: false, driverCategory: 'transport' });
  });

  it('does not promote a passenger or privileged account through category changes', async () => {
    for (const role of [UserRole.PASSENGER, UserRole.ADMIN, UserRole.SUPER_ADMIN]) {
      const f = profileFixture({ role, isDriver: false });
      await expect(f.service.updateProfile(f.user.id, { driverCategory: DriverCategory.TRANSPORT }))
        .rejects.toBeInstanceOf(BadRequestException);
      expect(f.update).not.toHaveBeenCalled();
    }
    expect(() => resolveDriverCategory('unknown', true)).toThrow(BadRequestException);
    expect(resolveDriverCategory(undefined, false)).toBeNull();
  });

  it('leaves every existing account unclassified when the migration is applied', async () => {
    const query = jest.fn();
    await new DriverCategory1780000120000().up({ query } as any);
    const sql = query.mock.calls.map(([value]) => value).join(' ');
    expect(sql).toMatch(/ADD COLUMN "driverCategory" text/);
    expect(sql).toMatch(/CHECK .*IS NULL.*'private'.*'transport'/);
    expect(sql).not.toMatch(/\b(UPDATE|DELETE|INSERT|DEFAULT|NOT NULL)\b/i);
  });

  it('exposes the category on public profiles without exposing credentials or changing premium status', async () => {
    const f = profileFixture({ driverCategory: DriverCategory.PRIVATE, isActive: true, password: 'test-only' });
    const builder = { innerJoin: jest.fn().mockReturnThis(), where: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(), addSelect: jest.fn().mockReturnThis(),
      getCount: async () => 0, getRawOne: async () => null };
    Object.assign(f.service, {
      userRepository: { findOne: async () => f.user },
      tripRepository: { count: async () => 0 }, bookingRepository: { count: async () => 0, createQueryBuilder: () => builder },
      ratingRepository: { createQueryBuilder: () => builder },
      subscriptionsService: { getPremiumOverview: async () => ({ isPremium: false, premiumBadgeEnabled: false }) },
    });
    const result = await f.service.getPublicUserInfo(f.user.id);
    expect(result.driverCategory).toBe(DriverCategory.PRIVATE);
    expect(result.isPremium).toBe(false);
    expect(result).not.toHaveProperty('password');
  });
});

function registrationFixture() {
  const repo = { findOne: jest.fn().mockResolvedValue(null), create: jest.fn(value => value),
    save: jest.fn(async value => ({ id: 'test-account', isActive: true, ...value })),
    update: jest.fn().mockResolvedValue({ affected: 1 }), manager: { transaction: jest.fn() } };
  repo.manager.transaction.mockImplementation(callback => callback({
    query: jest.fn().mockResolvedValue([]), getRepository: () => repo,
  }));
  const service = new AuthService(repo as any, {} as any,
    { signAsync: jest.fn().mockResolvedValue('test-only') } as any,
    { get: jest.fn(() => undefined) } as any, {} as any, {} as any,
    { assertReferralAttribution: async () => {}, registerUserInTransaction: async () => undefined } as any,
    {} as any, {} as any);
  return { repo, service };
}

describe.each(['phone', 'google', 'apple'])('%s registration category', method => {
  it.each([undefined, DriverCategory.PRIVATE, DriverCategory.TRANSPORT])('stores %s without activating driving rights', async driverCategory => {
    const { service, repo } = registrationFixture();
    const options = { ...common, driverCategory };
    if (method === 'phone') await service.register({ ...options, pin: '1234' });
    else if (method === 'google') await service.validateGoogleUser(
      { googleId: 'test-google', email: 'test@example.invalid', firstName: 'Test', lastName: 'Example', profilePicture: null },
      common.phone, undefined, options,
    );
    else await (service as any).validateAppleUser(
      { appleId: 'test-apple', firstName: 'Test', lastName: 'Example', emailVerified: true }, common.phone, options,
    );
    expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({
      driverCategory: driverCategory ?? null, role: UserRole.PASSENGER, isDriver: false,
      driverOnboardingRequestedAt: expect.any(Date),
    }));
  });
});

describe.each(['google', 'apple'])('%s existing-account login', method => {
  it('ignores registration category rather than silently overwriting the existing profile', async () => {
    const { service, repo } = registrationFixture();
    repo.findOne.mockResolvedValue({ id: 'test-account', isActive: true, status: UserStatus.ACTIVE,
      role: UserRole.DRIVER, isDriver: true, driverCategory: DriverCategory.PRIVATE });
    const options = { ...common, driverCategory: DriverCategory.TRANSPORT };
    if (method === 'google') await service.validateGoogleUser(
      { googleId: 'test-google', email: 'test@example.invalid', firstName: 'Test', lastName: 'Example', profilePicture: null },
      common.phone, undefined, options,
    );
    else await (service as any).validateAppleUser({ appleId: 'test-apple' }, common.phone, options);
    expect(repo.create).not.toHaveBeenCalled();
    for (const [, changes] of repo.update.mock.calls) expect(changes).not.toHaveProperty('driverCategory');
  });
});
