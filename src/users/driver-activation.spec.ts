import { BadRequestException, ForbiddenException, ValidationPipe } from '@nestjs/common';
import { activateRequestedDriver, assertDriverCanOperate } from './driver-activation';
import { User, UserRole, UserStatus } from './entities/user.entity';
import { KycDocument, KycStatus } from './entities/kyc-document.entity';
import { RegisterDto, GoogleMobileAuthDto, AppleMobileAuthDto } from '../auth/dto/auth.dto';
import { resolveSelfServiceDriverState } from './user-role.policy';
import type { EntityManager } from 'typeorm';

function fixture(overrides: Partial<User> = {}, status = KycStatus.APPROVED, hasVehicle = true) {
  const user = { id: 'account', role: UserRole.PASSENGER, isDriver: false,
    status: UserStatus.ACTIVE, isActive: true, driverOnboardingRequestedAt: null,
    driverActivatedAt: null, ...overrides } as User;
  const users = { findOne: jest.fn().mockResolvedValue(user),
    update: jest.fn(async (_id, patch) => { Object.assign(user, patch); }) };
  const identities = { findOne: jest.fn().mockResolvedValue({ status }) };
  const vehicles = { exists: jest.fn().mockResolvedValue(hasVehicle) };
  const manager = { getRepository: (entity) => entity === User ? users :
    entity === KycDocument ? identities : vehicles } as unknown as EntityManager;
  return { user, users, identities, vehicles, manager };
}

describe('explicit driver activation', () => {
  it('identity and vehicle without intent never promote a passenger', async () => {
    const f = fixture({ isDriver: true }); // corrupted legacy flag is not authority
    await activateRequestedDriver(f.manager, f.user.id);
    expect(f.user.role).toBe(UserRole.PASSENGER);
    expect(f.users.update).not.toHaveBeenCalled();
    expect(f.identities.findOne).not.toHaveBeenCalled();
  });

  it.each([KycStatus.PENDING, KycStatus.REJECTED])('records intent but never activates with %s identity', async status => {
    const f = fixture({}, status);
    await activateRequestedDriver(f.manager, f.user.id, { request: true });
    expect(f.user.role).toBe(UserRole.PASSENGER);
    expect(f.user.driverOnboardingRequestedAt).toBeInstanceOf(Date);
    expect(f.user.driverActivatedAt).toBeNull();
    await expect(activateRequestedDriver(f.manager, f.user.id, { request: true, requireReady: true }))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('identity without an active owned vehicle cannot activate', async () => {
    const f = fixture({}, KycStatus.APPROVED, false);
    await expect(activateRequestedDriver(f.manager, f.user.id, { request: true, requireReady: true }))
      .rejects.toThrow('Ajoutez un véhicule actif');
    expect(f.users.update).not.toHaveBeenCalled();
    expect(f.vehicles.exists).toHaveBeenCalledWith({ where: { ownerId: 'account', isActive: true } });
  });

  it('a missing identity cannot activate even with an owned vehicle', async () => {
    const f = fixture(); f.identities.findOne.mockResolvedValue(null);
    await expect(activateRequestedDriver(f.manager, f.user.id, { request: true, requireReady: true }))
      .rejects.toThrow('Votre identité');
    expect(f.users.update).not.toHaveBeenCalled();
  });

  it('activates after both requirements, with a user lock and partial writes', async () => {
    const f = fixture({ driverOnboardingRequestedAt: new Date('2026-09-24T10:00:00Z') });
    const requestedAt = f.user.driverOnboardingRequestedAt;
    await activateRequestedDriver(f.manager, f.user.id);
    expect(f.user).toMatchObject({ role: UserRole.DRIVER, isDriver: true,
      driverOnboardingRequestedAt: requestedAt, driverActivatedAt: expect.any(Date) });
    expect(f.users.findOne).toHaveBeenCalledWith({ where: { id: 'account' }, lock: { mode: 'pessimistic_write' } });
    expect(f.identities.findOne).toHaveBeenCalledWith({ where: { userId: 'account' },
      order: { createdAt: 'DESC', id: 'DESC' }, select: { id: true, status: true } });
    expect(Object.keys(f.users.update.mock.calls[0][1]).sort()).toEqual(
      ['driverActivatedAt', 'driverOnboardingRequestedAt', 'isDriver', 'role']);
    await activateRequestedDriver(f.manager, f.user.id);
    expect(f.users.update).toHaveBeenCalledTimes(1);
  });

  it.each([
    { role: UserRole.ADMIN }, { role: UserRole.SUPER_ADMIN },
    { isActive: false }, { status: UserStatus.SUSPENDED }, { status: UserStatus.INACTIVE },
  ])('does not activate a protected or disabled account: %j', async overrides => {
    const f = fixture(overrides);
    await expect(activateRequestedDriver(f.manager, f.user.id, { request: true })).rejects.toBeInstanceOf(ForbiddenException);
    await activateRequestedDriver(f.manager, f.user.id);
    expect(f.users.update).not.toHaveBeenCalled();
  });

  it('preserves legacy driver accounts without fabricating an activation date', async () => {
    const f = fixture({ role: UserRole.DRIVER, isDriver: true }, KycStatus.PENDING, false);
    await activateRequestedDriver(f.manager, f.user.id);
    expect(f.user.driverActivatedAt).toBeNull();
    expect(f.users.update).not.toHaveBeenCalled();
    await expect(assertDriverCanOperate(f.manager, f.user)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('publishing/accepting a trip only checks qualification and never activates', async () => {
    const f = fixture({ isDriver: true });
    await expect(assertDriverCanOperate(f.manager, f.user)).rejects.toBeInstanceOf(ForbiddenException);
    f.user.role = UserRole.DRIVER;
    await assertDriverCanOperate(f.manager, f.user);
    f.identities.findOne.mockResolvedValue({ status: KycStatus.REJECTED });
    await expect(assertDriverCanOperate(f.manager, f.user)).rejects.toBeInstanceOf(BadRequestException);
    expect(f.users.update).not.toHaveBeenCalled();
  });
});

describe('legacy multipart boolean under the production ValidationPipe', () => {
  const pipe = new ValidationPipe({ transform: true, whitelist: true,
    transformOptions: { enableImplicitConversion: true } });
  const payload = { phone: '+243900000000', pin: '1234', firstName: 'Test', lastName: 'Compte',
    idToken: 'test-token', identityToken: 'test-token', role: UserRole.PASSENGER };
  for (const dto of [RegisterDto, GoogleMobileAuthDto, AppleMobileAuthDto]) {
    it.each([false, 'false'])(`${dto.name}: %j stays false and passenger`, async isDriver => {
      const value = await pipe.transform({ ...payload, isDriver }, { type: 'body', metatype: dto });
      expect(value.isDriver).toBe(false);
      expect(resolveSelfServiceDriverState(value)).toEqual({ role: UserRole.PASSENGER, isDriver: false });
    });
    it(`${dto.name}: invalid booleans are rejected`, async () => {
      await expect(pipe.transform({ ...payload, isDriver: 'not-a-boolean' }, { type: 'body', metatype: dto }))
        .rejects.toBeInstanceOf(BadRequestException);
    });
    it(`${dto.name}: explicit driver intent does not grant driver permission`, async () => {
      const value = await pipe.transform({ ...payload, role: UserRole.DRIVER, isDriver: 'true' }, { type: 'body', metatype: dto });
      expect(value.isDriver).toBe(true);
      expect(resolveSelfServiceDriverState(value)).toEqual({ role: UserRole.PASSENGER, isDriver: false });
    });
  }
});
