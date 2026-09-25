import { BadRequestException } from '@nestjs/common';
import { UsersService } from './users.service';
import { AdminService } from '../admin/admin.service';
import { KycDocument, KycStatus } from './entities/kyc-document.entity';
import { User, UserRole, UserStatus } from './entities/user.entity';
import { AddExplicitDriverActivation1780000043000 } from '../database/migrations/1780000043000-AddExplicitDriverActivation';

function fixture(approved = true, vehicle = true) {
  const user: any = { id: 'account', role: UserRole.PASSENGER, isDriver: false,
    status: UserStatus.ACTIVE, isActive: true, firstName: 'Test', lastName: 'Compte',
    driverOnboardingRequestedAt: null, driverActivatedAt: null,
    password: 'fixture', accessToken: 'fixture', refreshToken: 'fixture', googleId: 'fixture', fcmToken: 'fixture' };
  let identity: any = { id: 'identity', userId: user.id, status: approved ? KycStatus.APPROVED : KycStatus.PENDING };
  const identities = { findOne: jest.fn(async () => ({ ...identity })),
    save: jest.fn(async value => { identity = { ...value }; return identity; }) };
  const users = { findOne: jest.fn(async () => ({ ...user })),
    update: jest.fn(async (_id, changes) => Object.assign(user, changes)), manager: {} as any };
  const manager = { getRepository: (entity) => entity === User ? users :
    entity === KycDocument ? identities : { exists: async () => vehicle } };
  users.manager.transaction = jest.fn(callback => callback(manager));
  const service: UsersService = Object.assign(Object.create(UsersService.prototype), {
    userRepository: users, dataSource: users.manager,
    logger: { log() {}, warn() {}, debug() {} },
    findOne: async () => ({ ...user, kycDocuments: [{ ...identity }] }),
    enrichUserWithPresignedUrls: async value => value,
  });
  const admin: AdminService = Object.assign(Object.create(AdminService.prototype), {
    userRepository: users, kycDocumentRepository: identities,
    logger: { log() {}, warn() {} }, ensureAdmin: async () => {},
  });
  return { user, users, identities, service, admin };
}

describe('onboarding API service flows', () => {
  it('request persists intent but does not expose credentials or activate before identity approval', async () => {
    const f = fixture(false);
    const response = await f.service.activateDriver('account');
    expect(response.role).toBe(UserRole.PASSENGER);
    expect(response.driverOnboardingRequestedAt).toBeInstanceOf(Date);
    for (const field of ['password', 'accessToken', 'refreshToken', 'googleId', 'fcmToken']) {
      expect(response).not.toHaveProperty(field);
    }
  });

  it.each([[false, true], [true, false]])('legacy profile PUT cannot bypass identity/vehicle conditions (%s/%s)', async (identity, vehicle) => {
    const f = fixture(identity, vehicle);
    await expect(f.service.updateProfile('account', { role: UserRole.DRIVER })).rejects.toBeInstanceOf(BadRequestException);
    expect(f.users.update).not.toHaveBeenCalled();
    expect(f.user.role).toBe(UserRole.PASSENGER);
  });

  it('legacy explicit driver PUT succeeds only when fully qualified', async () => {
    const f = fixture();
    await f.service.updateProfile('account', { role: UserRole.DRIVER });
    expect(f.user.role).toBe(UserRole.DRIVER);
    expect(f.user.driverActivatedAt).toBeInstanceOf(Date);
  });

  it('ordinary profile edits never infer driver intent, and old passenger writes cannot downgrade a driver', async () => {
    const f = fixture(); await f.service.updateProfile('account', {});
    expect(f.user.role).toBe(UserRole.PASSENGER);
    expect(f.user.driverOnboardingRequestedAt).toBeNull();
    for (const [, changes] of f.users.update.mock.calls) expect(changes).not.toHaveProperty('role');
    f.user.role = UserRole.DRIVER;
    await expect(f.service.updateProfile('account', { role: UserRole.PASSENGER })).rejects.toBeInstanceOf(BadRequestException);
  });

  it.each([false, true])('admin identity approval respects explicit driver intent=%s', async intent => {
    const f = fixture(false); if (intent) f.user.driverOnboardingRequestedAt = new Date();
    await f.admin.verifyKyc('identity', 'admin', true);
    expect(f.user.role).toBe(intent ? UserRole.DRIVER : UserRole.PASSENGER);
    expect(f.user.isDriver).toBe(intent);
    expect(f.users.findOne).toHaveBeenCalledWith({ where: { id: 'account' }, lock: { mode: 'pessimistic_write' } });
  });

  it('admin identity rejection never activates and approval never reactivates an inactive account', async () => {
    const f = fixture(false); f.user.driverOnboardingRequestedAt = new Date();
    await f.admin.verifyKyc('identity', 'admin', false);
    expect(f.user.role).toBe(UserRole.PASSENGER);
    f.user.status = UserStatus.INACTIVE;
    await f.admin.verifyKyc('identity', 'admin', true);
    expect(f.user.role).toBe(UserRole.PASSENGER);
    expect(f.user.status).toBe(UserStatus.INACTIVE);
  });

  it('migration is additive and never promotes, downgrades or backfills historical users', async () => {
    const query = jest.fn(), migration = new AddExplicitDriverActivation1780000043000();
    await migration.up({ query } as any);
    const sql = query.mock.calls.map(([text]) => text).join(' ');
    expect(sql).toMatch(/ADD COLUMN "driverOnboardingRequestedAt" timestamptz/);
    expect(sql).toMatch(/ADD COLUMN "driverActivatedAt" timestamptz/);
    expect(sql).not.toMatch(/\b(UPDATE|DELETE|DROP|INSERT)\b/i);
  });
});
