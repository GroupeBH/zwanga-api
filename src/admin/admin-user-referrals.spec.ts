import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AdminUserReferralsQuery } from './dto/admin-user-referrals.dto';
import { AdminReferralsService } from './admin-referrals.service';
import { AdminController } from './admin.controller';
import { UserRole, UserStatus } from '../users/entities/user.entity';
import { ROLES_KEY } from '../common/guards/roles.guard';

describe('Admin user referrals contracts', () => {
  it.each(Object.values(UserRole))(
    'accepts account role %s and a bounded page',
    async (role) => {
      const query = plainToInstance(AdminUserReferralsQuery, {
        role,
        page: '2',
        limit: '50',
        registeredFrom: '2026-11-01',
        registeredTo: '2026-11-24',
      });
      expect(await validate(query)).toEqual([]);
      expect(query).toMatchObject({ page: 2, limit: 50, role });
    },
  );
  it.each([
    { role: 'verified_passenger' },
    { role: ['driver'] },
    { page: '0' },
    { limit: '201' },
    { limit: '1.5' },
    { registeredFrom: '24/11/2026' },
  ])('rejects malformed filters %j', async (values) => {
    expect(
      (await validate(plainToInstance(AdminUserReferralsQuery, values))).length,
    ).toBeGreaterThan(0);
  });
  function setup() {
    const userRepository = {
      findOne: jest.fn().mockResolvedValue({ id: 'parent' }),
    };
    const qb: any = { getManyAndCount: jest.fn(), getMany: jest.fn() };
    for (const name of [
      'innerJoinAndSelect',
      'select',
      'where',
      'andWhere',
      'orderBy',
      'addOrderBy',
      'skip',
      'take',
      'clone',
    ])
      qb[name] = jest.fn(() => qb);
    const profiles = { createQueryBuilder: jest.fn(() => qb) };
    return {
      qb,
      profiles,
      userRepository,
      service: new AdminReferralsService(
        userRepository as any,
        {} as any,
        profiles as any,
        {} as any,
        {} as any,
        {} as any,
      ),
    };
  }
  it('selects only the displayed parent’s direct referrals and sanitizes every row', async () => {
    const { service, qb } = setup();
    qb.getManyAndCount.mockResolvedValue([
      [
        {
          id: 'profile',
          code: 'private-code',
          linkToken: 'private-token',
          user: {
            id: 'child',
            firstName: 'A',
            lastName: 'B',
            role: UserRole.DRIVER,
            status: UserStatus.ACTIVE,
            createdAt: new Date(),
            password: 'private-password',
            fcmToken: 'private-fcm',
          },
        },
      ],
      52,
    ]);
    const result = await service.getUserReferrals('parent', {
      page: 2,
      limit: 25,
      role: UserRole.DRIVER,
      registeredFrom: '2026-11-01',
      registeredTo: '2026-11-01',
    });
    expect(qb.where).toHaveBeenCalledWith(
      'profile.referredByUserId = :referrerUserId',
      { referrerUserId: 'parent' },
    );
    expect(qb.andWhere).toHaveBeenCalledWith(
      'referredUser.role = :referralRole',
      { referralRole: 'driver' },
    );
    expect(qb.andWhere).toHaveBeenCalledWith(
      'referredUser.createdAt >= :registeredFrom',
      { registeredFrom: new Date('2026-11-01T00:00:00+01:00') },
    );
    expect(qb.andWhere).toHaveBeenCalledWith(
      'referredUser.createdAt < :registeredTo',
      { registeredTo: new Date('2026-11-02T00:00:00+01:00') },
    );
    expect(result).toMatchObject({
      total: 52,
      page: 2,
      limit: 25,
      items: [{ user: { role: 'driver' } }],
    });
    expect(JSON.stringify(result)).not.toContain('private-');
  });
  it.each([
    { registeredFrom: '2026-02-30' },
    { registeredFrom: '2026-11-03', registeredTo: '2026-11-01' },
    { role: 'unknown' },
  ])(
    'rejects invalid dates or role before querying referral rows: %j',
    async (filters) => {
      const { service, profiles } = setup();
      await expect(
        service.getUserReferrals('parent', {
          page: 1,
          limit: 25,
          ...filters,
        } as any),
      ).rejects.toMatchObject({ status: 400 });
      await expect(
        service.exportUserReferrals('parent', {
          page: 1,
          limit: 25,
          ...filters,
        } as any),
      ).rejects.toMatchObject({ status: 400 });
      expect(profiles.createQueryBuilder).not.toHaveBeenCalled();
    },
  );
  it('returns not found for a missing parent and does not query unrelated users', async () => {
    const { service, profiles, userRepository } = setup();
    userRepository.findOne.mockResolvedValue(null);
    await expect(
      service.getUserReferrals('missing', new AdminUserReferralsQuery()),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.exportUserReferrals('missing', new AdminUserReferralsQuery()),
    ).rejects.toMatchObject({ status: 404 });
    expect(profiles.createQueryBuilder).not.toHaveBeenCalled();
  });
  it('keeps both endpoints under the existing administrator guard and forwards the selected user', async () => {
    for (const method of ['getUserReferrals', 'exportUserReferrals'] as const)
      expect(
        Reflect.getMetadata(ROLES_KEY, AdminController.prototype[method]),
      ).toEqual([UserRole.ADMIN]);
    const service = {
      getUserReferrals: jest.fn().mockResolvedValue({ items: [], total: 0 }),
      exportUserReferrals: jest
        .fn()
        .mockResolvedValue({
          buffer: Buffer.from('xls'),
          filename: 'filleuls.xls',
          contentType: 'application/vnd.ms-excel',
        }),
    };
    const controller = new AdminController(
      {} as any,
      service as any,
      {} as any,
    );
    const filters = { page: 2, limit: 25, role: UserRole.PASSENGER };
    await controller.getUserReferrals('parent', filters);
    const response = { set: jest.fn() };
    await controller.exportUserReferrals(response as any, 'parent', filters);
    expect(service.getUserReferrals).toHaveBeenCalledWith('parent', filters);
    expect(service.exportUserReferrals).toHaveBeenCalledWith('parent', filters);
    expect(response.set).toHaveBeenCalledWith(
      expect.objectContaining({
        'Content-Disposition': expect.stringContaining('filleuls.xls'),
      }),
    );
  });
});
