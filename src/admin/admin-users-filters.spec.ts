import { BadRequestException } from '@nestjs/common';
import { UserRole, UserStatus } from '../users/entities/user.entity';
import {
  ADMIN_USER_SORT_FIELDS,
  adminUserSortExpressions,
  parseAdminUserSort,
  parseAdminUserStatus,
} from './dto/admin-users.dto';
import { adminUserIdentity } from './admin-user-identity';
import { AdminService } from './admin.service';

describe('admin user status and sort validation', () => {
  it.each(Object.values(UserStatus))('accepts status %s', (value) => {
    expect(parseAdminUserStatus(value)).toBe(value);
  });
  it.each([undefined, '', 'all'])('accepts no status: %s', (value) => {
    expect(parseAdminUserStatus(value)).toBeUndefined();
  });
  it.each(['deleted', 'driver', ['active'], {}, "active' OR 1=1"])(
    'rejects invalid status %j',
    (value) => {
      expect(() => parseAdminUserStatus(value as any)).toThrow(
        BadRequestException,
      );
    },
  );
  it('keeps newest registrations as the default and uses A-Z for names', () => {
    expect(parseAdminUserSort()).toEqual({
      sortBy: 'createdAt',
      sortOrder: 'DESC',
    });
    expect(parseAdminUserSort('name')).toEqual({
      sortBy: 'name',
      sortOrder: 'ASC',
    });
  });
  it.each(ADMIN_USER_SORT_FIELDS)(
    'accepts ascending and descending %s',
    (field) => {
      expect(parseAdminUserSort(field, 'asc')).toEqual({
        sortBy: field,
        sortOrder: 'ASC',
      });
      expect(parseAdminUserSort(field, 'DESC')).toEqual({
        sortBy: field,
        sortOrder: 'DESC',
      });
    },
  );
  it.each([
    ['password', 'ASC'],
    ['createdAt; DROP TABLE users', 'DESC'],
    [['name'], 'ASC'],
    ['name', ['ASC']],
    ['name', 'random'],
    ['name', 'DESC NULLS FIRST'],
    ['name', {}],
  ])('rejects non-whitelisted sort %j %j', (field, order) => {
    expect(() => parseAdminUserSort(field as any, order as any)).toThrow(
      BadRequestException,
    );
  });
  it('sorts by last name then first name with case/accent folding', () => {
    const expressions = adminUserSortExpressions(parseAdminUserSort('name'));
    expect(expressions[0]).toContain('translate(lower(user.lastName)');
    expect(expressions[1]).toContain('translate(lower(user.firstName)');
  });
});

describe('admin identity presentation', () => {
  it.each([
    UserStatus.ACTIVE,
    UserStatus.INACTIVE,
    UserStatus.SUSPENDED,
    UserStatus.PENDING_KYC,
  ])('keeps the real name for a %s account even when disabled', (status) => {
    expect(
      adminUserIdentity({
        firstName: 'Jean',
        lastName: 'Mukendi',
        status,
        isActive: false,
      }),
    ).toEqual({ displayName: 'Jean Mukendi', isDeleted: false });
  });
  it('identifies the existing anonymized deletion marker without recovering erased data', () => {
    expect(
      adminUserIdentity({
        firstName: 'Compte',
        lastName: 'supprimé',
        status: UserStatus.INACTIVE,
        isActive: false,
      }),
    ).toEqual({ displayName: 'Compte supprimé', isDeleted: true });
  });
  it('does not label a retained account as deleted based on its name alone', () => {
    expect(
      adminUserIdentity({
        firstName: 'Compte',
        lastName: 'supprimé',
        status: UserStatus.INACTIVE,
        isActive: false,
        phone: '+243810000000',
      }).isDeleted,
    ).toBe(false);
  });
});

describe('admin user list and export new filters', () => {
  let query: any, repository: any, service: AdminService;
  beforeEach(() => {
    query = {
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
      getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
    };
    repository = {
      createQueryBuilder: jest.fn().mockReturnValue(query),
      findOne: jest.fn(),
      save: jest.fn((u) => u),
    };
    service = new AdminService(
      repository,
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
  it('shares status, name order and stable ID tie-breaker between list and export', async () => {
    await service.getAllUsers(
      2,
      10,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'suspended',
      'name',
      'DESC',
    );
    await service.exportUsersXls(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'suspended',
      'name',
      'DESC',
    );
    expect(query.andWhere).toHaveBeenCalledTimes(2);
    expect(query.andWhere).toHaveBeenCalledWith(
      'user.status = :adminUserStatus',
      { adminUserStatus: 'suspended' },
    );
    expect(query.orderBy).toHaveBeenCalledWith(
      expect.stringContaining('lower(user.lastName)'),
      'DESC',
      'NULLS LAST',
    );
    expect(query.addOrderBy).toHaveBeenCalledWith(
      expect.stringContaining('lower(user.firstName)'),
      'DESC',
      'NULLS LAST',
    );
    expect(query.addOrderBy).toHaveBeenCalledWith('user.id', 'DESC');
    expect(query.skip).toHaveBeenCalledWith(10);
    expect(query.take).toHaveBeenCalledWith(10);
  });
  it('leaves all statuses visible and registrations newest first by default', async () => {
    await service.getAllUsers();
    expect(query.andWhere).not.toHaveBeenCalled();
    expect(query.orderBy).toHaveBeenCalledWith(
      'user.createdAt',
      'DESC',
      'NULLS LAST',
    );
    expect(query.addOrderBy).toHaveBeenCalledWith('user.id', 'DESC');
  });
  it('rejects invalid filters before accessing the database', async () => {
    await expect(
      service.getAllUsers(
        1,
        10,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        'bad',
      ),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.exportUsersXls(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        'password',
      ),
    ).rejects.toThrow(BadRequestException);
    expect(repository.createQueryBuilder).not.toHaveBeenCalled();
  });
  it('suspends a user without erasing or replacing their name', async () => {
    const user = {
      id: 'user',
      firstName: 'Aline',
      lastName: 'Mbuyi',
      role: UserRole.PASSENGER,
    };
    repository.findOne
      .mockResolvedValueOnce({ id: 'admin', role: UserRole.ADMIN })
      .mockResolvedValueOnce(user);
    const result = await service.suspendUser('user', 'admin');
    expect(repository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        firstName: 'Aline',
        lastName: 'Mbuyi',
        status: UserStatus.SUSPENDED,
        isActive: false,
      }),
    );
    expect(result).toMatchObject({
      displayName: 'Aline Mbuyi',
      isDeleted: false,
    });
    expect(result).not.toHaveProperty('accessToken');
  });
});
