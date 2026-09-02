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
  }) as User;

const createService = (user: User) => {
  const userRepository = {
    findOne: jest.fn().mockResolvedValue(user),
    save: jest.fn((payload: User) => Promise.resolve(payload)),
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
  it('normalizes legal names before KYC approval', async () => {
    const user = createUser();
    const { service } = createService(user);

    const result = await service.updateProfile('user-1', {
      firstName: '  Eugène ',
      lastName: '  Bosuku  ',
    });

    expect(result.firstName).toBe('Eugène');
    expect(result.lastName).toBe('Bosuku');
  });

  it('rejects a legal name change after KYC approval', async () => {
    const user = createUser(KycStatus.APPROVED);
    const { service, userRepository } = createService(user);

    await expect(
      service.updateProfile('user-1', { lastName: 'Nom différent' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(userRepository.save).not.toHaveBeenCalled();
  });

  it('allows spacing and case normalization after KYC approval', async () => {
    const user = createUser(KycStatus.APPROVED);
    const { service, userRepository } = createService(user);

    await service.updateProfile('user-1', {
      firstName: '  EUGENE ',
      lastName: 'bosuku   buania',
    });

    expect(userRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        firstName: 'EUGENE',
        lastName: 'bosuku buania',
      }),
    );
  });
});
