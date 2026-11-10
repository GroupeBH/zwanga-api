import { BadRequestException } from '@nestjs/common';
import { KycStatus } from './entities/kyc-document.entity';
import { User, UserRole, UserStatus } from './entities/user.entity';
import { UsersService } from './users.service';

const createUser = (kycStatus?: KycStatus) =>
  ({
    id: 'user-1',
    firstName: 'Eugène',
    lastName: 'Bosuku Buania',
    phone: '+243900000000',
    profilePicture: null,
    role: UserRole.DRIVER,
    status: UserStatus.ACTIVE,
    vehicles: [],
    kycDocuments: kycStatus ? [{ status: kycStatus }] : [],
  }) as unknown as User;

const createService = (user: User) => {
  const userRepository = {
    findOne: jest.fn().mockResolvedValue(user),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  const service = new UsersService(
    userRepository as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
  );

  return { service, userRepository };
};

describe('UsersService legal identity', () => {
  it('does not clear verification or rewrite an old identifier for a formatting-only edit', async () => {
    const user = createUser();
    user.phone = '0900000000';
    user.isPhoneVerified = true;
    const { service, userRepository } = createService(user);
    await service.updateProfile(user.id, { phone: '+243900000000' });
    expect(userRepository.update).toHaveBeenCalledWith(user.id, expect.objectContaining({ phone: '0900000000' }));
    expect(userRepository.update.mock.calls[0][1]).not.toHaveProperty('isPhoneVerified');
  });
  it('does not allow a stolen admin session to redirect the financial OTP through profile editing', async () => {
    const user = createUser(); user.role = UserRole.SUPER_ADMIN;
    const { service, userRepository } = createService(user);
    await expect(service.updateProfile(user.id, { phone: '+243900000001' })).rejects.toMatchObject({
      response: { code: 'ADMIN_PHONE_CHANGE_REQUIRES_SUPPORT' },
    });
    expect(userRepository.update).not.toHaveBeenCalled();
  });
  it('normalizes legal names before KYC approval', async () => {
    const user = createUser();
    const { service, userRepository } = createService(user);

    const result = await service.updateProfile('user-1', {
      firstName: '  Eugène ',
      lastName: '  Bosuku  ',
    });

    expect(result.firstName).toBe('Eugène');
    expect(result.lastName).toBe('Bosuku');
    expect(userRepository.update).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ firstName: 'Eugène', lastName: 'Bosuku' }),
    );
  });

  it('rejects a legal name change after KYC approval', async () => {
    const user = createUser(KycStatus.APPROVED);
    const { service, userRepository } = createService(user);

    await expect(
      service.updateProfile('user-1', { lastName: 'Nom différent' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(userRepository.update).not.toHaveBeenCalled();
  });

  it('allows spacing and case normalization after KYC approval', async () => {
    const user = createUser(KycStatus.APPROVED);
    const { service, userRepository } = createService(user);

    await service.updateProfile('user-1', {
      firstName: '  EUGENE ',
      lastName: 'bosuku   buania',
    });

    expect(userRepository.update).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        firstName: 'EUGENE',
        lastName: 'bosuku buania',
      }),
    );
  });
});
