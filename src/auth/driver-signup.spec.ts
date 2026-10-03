import { BadRequestException } from '@nestjs/common';
import { AuthService } from './auth.service';
import { UserRole } from '../users/entities/user.entity';

function fixture() {
  const users = { findOne: jest.fn().mockResolvedValue(null), create: jest.fn(value => value),
    save: jest.fn(async value => ({ isActive: true, ...value, id: 'new-account' })), update: jest.fn() };
  const jwt = { signAsync: jest.fn(async () => 'test-token') };
  const vehicles = { create: jest.fn() };
  const service = new AuthService(users as any, {} as any, jwt as any,
    { get: jest.fn() } as any, {} as any, vehicles as any,
    { assertReferralAttribution: jest.fn(), registerUser: jest.fn() } as any, {} as any, {} as any);
  const signup = (provider: string, role: UserRole, isDriver: boolean, vehicle?: any) => {
    const details = { firstName: 'Test', lastName: 'Compte' };
    const options = { ...details, role, isDriver, vehicle };
    if (provider === 'phone') return service.register({ ...options, phone: '+243900000000', pin: '1234' });
    if (provider === 'google') return service.validateGoogleUser({ ...details,
      googleId: 'google-test', email: 'test@example.invalid', profilePicture: null }, '+243900000000', null, options);
    return service.validateAppleUser({ ...details, appleId: 'apple-test',
      email: 'test@example.invalid', emailVerified: true }, '+243900000000', options);
  };
  return { users, jwt, vehicles, signup };
}

for (const provider of ['phone', 'google', 'apple']) describe(`${provider} signup`, () => {
  it('persists a passenger, no driver intent, and passenger tokens', async () => {
    const f = fixture(); await f.signup(provider, UserRole.PASSENGER, false);
    expect(f.users.create).toHaveBeenCalledWith(expect.objectContaining({
      role: UserRole.PASSENGER, isDriver: false, driverOnboardingRequestedAt: null,
    }));
    expect(f.vehicles.create).not.toHaveBeenCalled();
    expect(f.jwt.signAsync).toHaveBeenCalledWith(expect.objectContaining({ role: UserRole.PASSENGER }), expect.anything());
    for (const [, changes] of f.users.update.mock.calls as any[]) {
      expect(changes).not.toHaveProperty('role');
      expect(changes).not.toHaveProperty('isDriver');
    }
  });

  it('records driver intent and vehicle without granting driver permission', async () => {
    const f = fixture(), vehicle = { type: 'car', licensePlate: '1234AB56' };
    await f.signup(provider, UserRole.DRIVER, true, vehicle);
    expect(f.users.create).toHaveBeenCalledWith(expect.objectContaining({
      role: UserRole.PASSENGER, isDriver: false, driverOnboardingRequestedAt: expect.any(Date),
    }));
    expect(f.vehicles.create).toHaveBeenCalledWith('new-account', vehicle);
    expect(f.jwt.signAsync).toHaveBeenCalledWith(expect.objectContaining({ role: UserRole.PASSENGER }), expect.anything());
  });

  it.each([true, false])('rejects contradictory passenger/vehicle inputs before creating an account (flag=%s)', async flag => {
    const f = fixture();
    await expect(f.signup(provider, UserRole.PASSENGER, flag, flag ? undefined : { type: 'car' }))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(f.users.save).not.toHaveBeenCalled();
    expect(f.vehicles.create).not.toHaveBeenCalled();
  });
});
