import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { UserRole, UserStatus } from '../users/entities/user.entity';
import { AdminService } from './admin.service';

describe('AdminService back-office account management', () => {
  const userRepository = {
    findOne: jest.fn(),
    save: jest.fn(),
  };
  let service: AdminService;

  const superAdmin = {
    id: 'super-1',
    role: UserRole.SUPER_ADMIN,
    isActive: true,
  };
  const adminAccount = {
    id: 'admin-1',
    role: UserRole.ADMIN,
    firstName: 'Alice',
    lastName: 'Admin',
    phone: '+243810000000',
    status: UserStatus.ACTIVE,
    isActive: true,
    isPhoneVerified: true,
    passwordChangeRequired: false,
    password: 'hashed',
    accessToken: 'token',
    refreshToken: 'refresh',
    fcmToken: 'fcm',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AdminService(
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
    );
  });

  it('deactivates an operational admin and revokes sessions', async () => {
    userRepository.findOne
      .mockResolvedValueOnce(superAdmin)
      .mockResolvedValueOnce(adminAccount);
    userRepository.save.mockImplementation(async (user) => user);

    const result = await service.deactivateAdminAccount('super-1', 'admin-1');

    expect(result.isActive).toBe(false);
    expect(result.status).toBe(UserStatus.SUSPENDED);
    expect(userRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        accessToken: null,
        refreshToken: null,
        fcmToken: null,
      }),
    );
  });

  it('refuses to deactivate the connected super admin', async () => {
    userRepository.findOne.mockResolvedValue(superAdmin);

    await expect(
      service.deactivateAdminAccount('super-1', 'super-1'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(userRepository.save).not.toHaveBeenCalled();
  });

  it('refuses to alter another super admin from this list', async () => {
    userRepository.findOne
      .mockResolvedValueOnce(superAdmin)
      .mockResolvedValueOnce({ ...superAdmin, id: 'super-2' });

    await expect(
      service.resetAdminAccountPassword('super-1', 'super-2', 'Nouveau-2026!'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
