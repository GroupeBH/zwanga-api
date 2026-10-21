import { BadRequestException } from '@nestjs/common';
import {
  UserGender,
  UserRole,
  UserStatus,
} from '../users/entities/user.entity';
import { KycStatus } from '../users/entities/kyc-document.entity';
import { Vehicle, VehicleType } from '../vehicles/entities/vehicle.entity';
import {
  normalizeUserSearch,
  parseAdminUserSegment,
  parseAdminVehicleType,
  parseRegistrationRange,
  userSearchLikePattern,
} from './dto/admin-users.dto';
import { parseKycStatus } from './dto/admin-kyc.dto';
import { AdminService } from './admin.service';
import { AdminController } from './admin.controller';
import { ROLES_KEY } from '../common/guards/roles.guard';
import { QUALIFIED_DRIVER_CONDITION } from './qualified-driver';
import {
  buildUsersSpreadsheet,
  usersSpreadsheetFilename,
} from './users-spreadsheet';

function createUsersQueryMock() {
  const vehicleQuery = {
    select: jest.fn().mockReturnThis(),
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getQuery: jest.fn().mockReturnValue('(active-vehicle-subquery)'),
  };
  const query = {
    subQuery: jest.fn().mockReturnValue(vehicleQuery),
    andWhere: jest.fn(),
    orderBy: jest.fn(),
    addOrderBy: jest.fn(),
    skip: jest.fn(),
    take: jest.fn(),
    getManyAndCount: jest.fn(),
    getMany: jest.fn(),
    getCount: jest.fn(),
  };
  for (const method of ['andWhere', 'orderBy', 'addOrderBy', 'skip', 'take'] as const) {
    query[method].mockReturnValue(query);
  }
  return query;
}

describe('parseAdminVehicleType', () => {
  it.each(Object.values(VehicleType))('accepts %s', (type) => {
    expect(parseAdminVehicleType(type)).toBe(type);
  });

  it.each([undefined, null, ''])('treats %s as no filter', (value) => {
    expect(parseAdminVehicleType(value)).toBeUndefined();
  });

  it.each([
    'truck',
    'all',
    'CAR',
    'car ',
    ' ',
    'car,motorcycle_2_wheels',
    "car' OR 1=1--",
    ['car'],
    { type: 'car' },
  ])('rejects unsupported or malformed values: %j', (value) => {
    expect(() => parseAdminVehicleType(value as any)).toThrow(
      BadRequestException,
    );
  });
});

describe('AdminController user vehicle filter contract', () => {
  it('forwards the optional filter to both endpoints without changing admin access', async () => {
    const service = {
      getAllUsers: jest.fn().mockResolvedValue({ users: [], total: 0 }),
      exportUsersXls: jest.fn().mockResolvedValue({
        buffer: Buffer.from('spreadsheet'),
        filename: 'users.xls',
        contentType: 'application/vnd.ms-excel',
      }),
    };
    const controller = new AdminController(
      service as any,
      {} as any,
      {} as any,
    );
    await controller.getAllUsers(
      2,
      15,
      'driver',
      '2026-10-01',
      '2026-10-19',
      'JEAN',
      'car',
      'suspended',
      'name',
      'ASC',
    );
    expect(service.getAllUsers).toHaveBeenCalledWith(
      2,
      15,
      'driver',
      '2026-10-01',
      '2026-10-19',
      'JEAN',
      'car',
      'suspended',
      'name',
      'ASC',
    );
    const response = { set: jest.fn() };
    await controller.exportUsers(
      response as any,
      'driver',
      '2026-10-01',
      '2026-10-19',
      'JEAN',
      'car',
      'suspended',
      'name',
      'ASC',
    );
    expect(service.exportUsersXls).toHaveBeenCalledWith(
      'driver',
      '2026-10-01',
      '2026-10-19',
      'JEAN',
      'car',
      'suspended',
      'name',
      'ASC',
    );
    expect(response.set).toHaveBeenCalledWith(
      expect.objectContaining({ 'Cache-Control': 'no-store' }),
    );
    for (const method of ['getAllUsers', 'exportUsers'] as const) {
      expect(
        Reflect.getMetadata(ROLES_KEY, AdminController.prototype[method]),
      ).toEqual([UserRole.ADMIN]);
    }
  });
});

describe('parseAdminUserSegment', () => {
  it('accepts driver, passenger and verified passenger filters', () => {
    expect(parseAdminUserSegment('driver')).toBe('driver');
    expect(parseAdminUserSegment('passenger')).toBe('passenger');
    expect(parseAdminUserSegment('verified_passenger')).toBe(
      'verified_passenger',
    );
  });

  it('treats an empty value as no filter', () => {
    expect(parseAdminUserSegment(undefined)).toBeUndefined();
    expect(parseAdminUserSegment('')).toBeUndefined();
  });

  it('rejects unsupported roles', () => {
    expect(() => parseAdminUserSegment('admin')).toThrow(BadRequestException);
    expect(() => parseAdminUserSegment('driver ')).toThrow(BadRequestException);
  });
});

describe('normalizeUserSearch', () => {
  it('folds case and accents before matching', () => {
    expect(normalizeUserSearch('  JEAN ')).toBe('jean');
    expect(normalizeUserSearch('Éric')).toBe('eric');
    expect(normalizeUserSearch('   ')).toBeUndefined();
  });

  it('escapes LIKE wildcards in the folded term', () => {
    expect(userSearchLikePattern(normalizeUserSearch('100%_!')!)).toBe(
      '%100!%!_!!%',
    );
  });
});

describe('parseRegistrationRange', () => {
  it('treats empty values as no filter', () => {
    expect(parseRegistrationRange(undefined, '')).toEqual({
      from: undefined,
      to: undefined,
    });
  });

  it('bounds Kinshasa calendar days, end exclusive', () => {
    const range = parseRegistrationRange('2026-10-01', '2026-10-07');
    expect(range.from?.toISOString()).toBe('2026-09-30T23:00:00.000Z');
    expect(range.to?.toISOString()).toBe('2026-10-07T23:00:00.000Z');
  });

  it('rejects an inverted range and an impossible day', () => {
    expect(() => parseRegistrationRange('2026-10-08', '2026-10-01')).toThrow(
      BadRequestException,
    );
    expect(() => parseRegistrationRange('2026-02-31', undefined)).toThrow(
      BadRequestException,
    );
  });
});

describe('parseKycStatus', () => {
  it('accepts pending, approved and rejected', () => {
    expect(parseKycStatus('pending')).toBe(KycStatus.PENDING);
    expect(parseKycStatus('approved')).toBe(KycStatus.APPROVED);
    expect(parseKycStatus('rejected')).toBe(KycStatus.REJECTED);
  });

  it('treats all or empty as no filter', () => {
    expect(parseKycStatus('all')).toBeUndefined();
    expect(parseKycStatus('')).toBeUndefined();
    expect(parseKycStatus(undefined)).toBeUndefined();
  });

  it('rejects unknown statuses', () => {
    expect(() => parseKycStatus('verified')).toThrow(BadRequestException);
  });
});

describe('users spreadsheet', () => {
  it('names the file according to the driver filter', () => {
    expect(
      usersSpreadsheetFilename('driver', new Date('2026-09-18T10:00:00.000Z')),
    ).toBe('utilisateurs-zwanga-conducteurs-2026-09-18.xls');
    expect(
      usersSpreadsheetFilename(
        'passenger',
        new Date('2026-09-18T10:00:00.000Z'),
      ),
    ).toBe('utilisateurs-zwanga-passagers-2026-09-18.xls');
    expect(
      usersSpreadsheetFilename(
        'verified_passenger',
        new Date('2026-09-18T10:00:00.000Z'),
      ),
    ).toBe('utilisateurs-zwanga-passagers-kyc-2026-09-18.xls');
    expect(
      usersSpreadsheetFilename(undefined, new Date('2026-09-18T10:00:00.000Z')),
    ).toBe('utilisateurs-zwanga-tous-2026-09-18.xls');
  });

  it('marks a declared driver without KYC and vehicle as not operational', () => {
    const workbook = buildUsersSpreadsheet([
      {
        id: 'user-1',
        firstName: 'Aline <Test>',
        lastName: 'Mbuyi',
        email: 'aline@example.com',
        phone: '+243810000000',
        gender: UserGender.FEMALE,
        role: UserRole.DRIVER,
        isDriver: true,
        isQualifiedDriver: false,
        hasApprovedKyc: false,
        hasActiveVehicle: false,
        status: UserStatus.PENDING_KYC,
        isActive: true,
        isEmailVerified: true,
        isPhoneVerified: true,
        lastLoginAt: new Date('2026-09-18T08:30:00.000Z'),
        createdAt: new Date('2026-01-02T00:00:00.000Z'),
      },
    ]).toString('utf8');

    expect(workbook).toContain('<?mso-application progid="Excel.Sheet"?>');
    expect(workbook).toContain('Aline &lt;Test&gt;');
    expect(workbook).toContain('Profil déclaré');
    expect(workbook).toContain('Conducteur');
    expect(workbook).toContain('KYC validé');
    expect(workbook).toContain('aline@example.com');
    expect(workbook).toContain('Non');
  });
});

describe('AdminService user listing and export', () => {
  const usersQuery = createUsersQueryMock();
  const userRepository = {
    createQueryBuilder: jest.fn(),
    manager: { find: jest.fn() },
  };
  const kycDocumentRepository = { find: jest.fn() };
  let service: AdminService;

  beforeEach(() => {
    jest.clearAllMocks();
    userRepository.createQueryBuilder.mockReturnValue(usersQuery);
    kycDocumentRepository.find.mockResolvedValue([]);
    userRepository.manager.find.mockResolvedValue([]);
    service = new AdminService(
      userRepository as any,
      kycDocumentRepository as any,
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

  it('filters the user list by operational drivers, not declared role', async () => {
    usersQuery.getManyAndCount.mockResolvedValue([[], 0]);

    await service.getAllUsers(1, 10, 'driver');

    expect(usersQuery.andWhere).toHaveBeenCalledWith(
      QUALIFIED_DRIVER_CONDITION('user'),
      expect.objectContaining({ approvedKycStatus: 'approved' }),
    );
    expect(usersQuery.skip).toHaveBeenCalledWith(0);
    expect(usersQuery.take).toHaveBeenCalledWith(10);
    expect(usersQuery.subQuery).not.toHaveBeenCalled();
  });

  it.each(Object.values(VehicleType))(
    'shares the active-vehicle filter between list and export: %s',
    async (type) => {
      usersQuery.getManyAndCount.mockResolvedValue([[], 0]);
      usersQuery.getMany.mockResolvedValue([]);
      await service.getAllUsers(
        2,
        5,
        undefined,
        undefined,
        undefined,
        undefined,
        type,
      );
      await service.exportUsersXls(
        undefined,
        undefined,
        undefined,
        undefined,
        type,
      );
      const vehicleQuery = usersQuery.subQuery();
      expect(vehicleQuery.from).toHaveBeenCalledWith(Vehicle, 'activeVehicle');
      expect(vehicleQuery.where).toHaveBeenCalledWith(
        'activeVehicle.ownerId = user.id',
      );
      expect(vehicleQuery.andWhere).toHaveBeenCalledWith(
        'activeVehicle.isActive = :adminVehicleActive',
        { adminVehicleActive: true },
      );
      expect(vehicleQuery.andWhere).toHaveBeenCalledWith(
        'activeVehicle.type = :adminVehicleType',
        { adminVehicleType: type },
      );
      expect(usersQuery.andWhere).toHaveBeenCalledTimes(2);
      expect(usersQuery.andWhere).toHaveBeenCalledWith(
        'EXISTS (active-vehicle-subquery)',
      );
      expect(usersQuery.skip).toHaveBeenCalledWith(5);
      expect(usersQuery.take).toHaveBeenCalledWith(5);
    },
  );

  it('rejects invalid vehicle types before querying either endpoint', async () => {
    await expect(
      service.getAllUsers(
        1,
        10,
        undefined,
        undefined,
        undefined,
        undefined,
        'truck',
      ),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.exportUsersXls(
        undefined,
        undefined,
        undefined,
        undefined,
        'truck',
      ),
    ).rejects.toThrow(BadRequestException);
    expect(userRepository.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('returns the latest active type or null in one batched lookup, preferring a matching type when filtered', async () => {
    usersQuery.getManyAndCount.mockResolvedValue([
      [
        { id: 'multi', role: UserRole.DRIVER, password: 'secret' },
        { id: 'none', role: UserRole.PASSENGER },
      ],
      2,
    ]);
    userRepository.manager.find.mockResolvedValue([
      {
        id: 'newest',
        ownerId: 'multi',
        type: VehicleType.MOTORCYCLE_TWO_WHEELS,
      },
      { id: 'older', ownerId: 'multi', type: VehicleType.CAR },
    ]);
    let result = await service.getAllUsers();
    expect(result.users[0]).toEqual(
      expect.objectContaining({
        activeVehicleType: VehicleType.MOTORCYCLE_TWO_WHEELS,
        hasActiveVehicle: true,
      }),
    );
    expect(result.users[0]).not.toHaveProperty('password');
    expect(result.users[1]).toEqual(
      expect.objectContaining({
        activeVehicleType: null,
        hasActiveVehicle: false,
      }),
    );
    expect(userRepository.manager.find).toHaveBeenCalledTimes(1);
    expect(userRepository.manager.find).toHaveBeenCalledWith(
      Vehicle,
      expect.objectContaining({
        where: expect.objectContaining({ isActive: true }),
        select: ['id', 'ownerId', 'type'],
        order: { createdAt: 'DESC', id: 'DESC' },
      }),
    );
    result = await service.getAllUsers(
      1,
      10,
      undefined,
      undefined,
      undefined,
      undefined,
      'car',
    );
    expect(result.users[0].activeVehicleType).toBe('car');
  });

  it('matches the list without regard to case', async () => {
    usersQuery.getManyAndCount.mockResolvedValue([[], 0]);

    await service.getAllUsers(1, 10, undefined, undefined, undefined, 'JEAN');

    expect(usersQuery.andWhere).toHaveBeenCalledWith(
      expect.stringContaining('lower('),
      { userSearch: '%jean%' },
    );
  });

  it('limits the list to the Kinshasa registration days requested', async () => {
    usersQuery.getManyAndCount.mockResolvedValue([[], 0]);

    await service.getAllUsers(1, 10, undefined, '2026-10-01', '2026-10-01');

    expect(usersQuery.andWhere).toHaveBeenCalledWith(
      'user.createdAt >= :registeredFrom',
      { registeredFrom: new Date('2026-10-01T00:00:00+01:00') },
    );
    expect(usersQuery.andWhere).toHaveBeenCalledWith(
      'user.createdAt < :registeredTo',
      { registeredTo: new Date('2026-10-02T00:00:00+01:00') },
    );
  });

  it('exports non-drivers and annotates qualification flags', async () => {
    usersQuery.getMany.mockResolvedValue([
      {
        id: 'passenger-1',
        firstName: 'Paul',
        lastName: 'Kabila',
        email: 'paul@example.com',
        phone: '+243820000000',
        gender: UserGender.MALE,
        role: UserRole.PASSENGER,
        isDriver: false,
        status: UserStatus.ACTIVE,
        isActive: true,
        isEmailVerified: false,
        isPhoneVerified: true,
        lastLoginAt: null,
        createdAt: new Date('2026-02-01T00:00:00.000Z'),
        password: 'must-not-leak',
      },
    ]);

    const file = await service.exportUsersXls('passenger');

    expect(usersQuery.andWhere).toHaveBeenCalledWith(
      expect.stringContaining('NOT'),
      expect.objectContaining({ approvedKycStatus: 'approved' }),
    );
    expect(file.filename).toContain('passagers');
    expect(file.contentType).toContain('application/vnd.ms-excel');
    expect(file.buffer.toString('utf8')).toContain('Paul');
    expect(file.buffer.toString('utf8')).not.toContain('must-not-leak');
  });
});
