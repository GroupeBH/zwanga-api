import * as bcrypt from 'bcrypt';
import { Repository } from 'typeorm';
import { User, UserRole, UserStatus } from '../users/entities/user.entity';
import {
  normalizeAdminProvisioningInput,
  provisionAdminAccount,
} from './admin-account.provisioning';

function createRepositoryMock() {
  return {
    findOne: jest.fn(),
    create: jest.fn((input: Partial<User>) => input as User),
    save: jest.fn(
      async (input: User) =>
        ({ ...input, id: input.id ?? 'admin-id' }) as User,
    ),
  };
}

describe('admin account provisioning', () => {
  it('normalizes operator input', () => {
    expect(
      normalizeAdminProvisioningInput({
        phone: '+243 900 000 000',
        firstName: '  Alice ',
        lastName: ' Admin  ',
        password: 'Temporaire-2026!',
      }),
    ).toEqual({
      phone: '+243900000000',
      firstName: 'Alice',
      lastName: 'Admin',
      password: 'Temporaire-2026!',
      role: UserRole.ADMIN,
      passwordChangeRequired: false,
      isPhoneVerified: false,
    });
  });

  it('creates an active admin with a hashed temporary password', async () => {
    const repositoryMock = createRepositoryMock();
    repositoryMock.findOne.mockResolvedValue(null);

    const user = await provisionAdminAccount(
      repositoryMock as unknown as Repository<User>,
      {
        phone: '+243900000000',
        firstName: 'Alice',
        lastName: 'Admin',
        password: 'Temporaire-2026!',
        passwordChangeRequired: true,
      },
    );

    expect(user.role).toBe(UserRole.ADMIN);
    expect(user.status).toBe(UserStatus.ACTIVE);
    expect(user.isActive).toBe(true);
    expect(user.isDriver).toBe(false);
    expect(user.passwordChangeRequired).toBe(true);
    await expect(
      bcrypt.compare('Temporaire-2026!', user.password),
    ).resolves.toBe(true);
  });

  it('creates an active super admin when requested', async () => {
    const repositoryMock = createRepositoryMock();
    repositoryMock.findOne.mockResolvedValue(null);

    const user = await provisionAdminAccount(
      repositoryMock as unknown as Repository<User>,
      {
        phone: '+243900000000',
        firstName: 'Alice',
        lastName: 'Root',
        password: 'Temporaire-2026!',
        role: UserRole.SUPER_ADMIN,
        isPhoneVerified: true,
      },
    );

    expect(user.role).toBe(UserRole.SUPER_ADMIN);
    expect(user.status).toBe(UserStatus.ACTIVE);
    expect(user.isPhoneVerified).toBe(true);
    await expect(
      bcrypt.compare('Temporaire-2026!', user.password),
    ).resolves.toBe(true);
  });

  it('refuses to promote or replace an existing account', async () => {
    const repositoryMock = createRepositoryMock();
    repositoryMock.findOne.mockResolvedValue({
      id: 'existing-user',
      role: UserRole.PASSENGER,
    } as User);

    await expect(
      provisionAdminAccount(repositoryMock as unknown as Repository<User>, {
        phone: '+243900000000',
        firstName: 'Alice',
        lastName: 'Admin',
        password: 'Temporaire-2026!',
      }),
    ).rejects.toThrow('Aucun rôle existant n’a été modifié');
    expect(repositoryMock.create).not.toHaveBeenCalled();
    expect(repositoryMock.save).not.toHaveBeenCalled();
  });

  it('promotes an existing self-service account when explicitly allowed', async () => {
    const repositoryMock = createRepositoryMock();
    repositoryMock.findOne.mockResolvedValue({
      id: 'existing-user',
      phone: '+243900000000',
      firstName: 'Old',
      lastName: 'Passenger',
      role: UserRole.PASSENGER,
      status: UserStatus.PENDING_KYC,
      isActive: true,
      isDriver: true,
      isPhoneVerified: true,
      accessToken: 'old-access-token',
      refreshToken: 'old-refresh-token',
      fcmToken: 'old-fcm-token',
    } as User);

    const user = await provisionAdminAccount(
      repositoryMock as unknown as Repository<User>,
      {
        phone: '+243900000000',
        firstName: 'Alice',
        lastName: 'Admin',
        password: 'Temporaire-2026!',
        role: UserRole.ADMIN,
        passwordChangeRequired: true,
        existingAccountStrategy: 'promote_self_service',
      },
    );

    expect(repositoryMock.create).not.toHaveBeenCalled();
    expect(user.id).toBe('existing-user');
    expect(user.firstName).toBe('Alice');
    expect(user.lastName).toBe('Admin');
    expect(user.role).toBe(UserRole.ADMIN);
    expect(user.status).toBe(UserStatus.ACTIVE);
    expect(user.isDriver).toBe(false);
    expect(user.isPhoneVerified).toBe(true);
    expect(user.passwordChangeRequired).toBe(true);
    expect(user.accessToken).toBeNull();
    expect(user.refreshToken).toBeNull();
    expect(user.fcmToken).toBeNull();
    await expect(
      bcrypt.compare('Temporaire-2026!', user.password),
    ).resolves.toBe(true);
  });

  it('refuses to overwrite an existing back-office account', async () => {
    const repositoryMock = createRepositoryMock();
    repositoryMock.findOne.mockResolvedValue({
      id: 'existing-admin',
      phone: '+243900000000',
      role: UserRole.ADMIN,
    } as User);

    await expect(
      provisionAdminAccount(repositoryMock as unknown as Repository<User>, {
        phone: '+243900000000',
        firstName: 'Alice',
        lastName: 'Admin',
        password: 'Temporaire-2026!',
        existingAccountStrategy: 'promote_self_service',
      }),
    ).rejects.toThrow('compte back-office');
    expect(repositoryMock.create).not.toHaveBeenCalled();
    expect(repositoryMock.save).not.toHaveBeenCalled();
  });
});
