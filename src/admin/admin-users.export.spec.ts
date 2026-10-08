import { BadRequestException } from '@nestjs/common';
import {
  UserGender,
  UserRole,
  UserStatus,
} from '../users/entities/user.entity';
import { KycStatus } from '../users/entities/kyc-document.entity';
import {
  parseAdminUserSegment,
  parseRegistrationRange,
} from './dto/admin-users.dto';
import { parseKycStatus } from './dto/admin-kyc.dto';
import { AdminService } from './admin.service';
import { QUALIFIED_DRIVER_CONDITION } from './qualified-driver';
import {
  buildUsersSpreadsheet,
  usersSpreadsheetFilename,
} from './users-spreadsheet';

function createUsersQueryMock() {
  const query = {
    andWhere: jest.fn(),
    orderBy: jest.fn(),
    skip: jest.fn(),
    take: jest.fn(),
    getManyAndCount: jest.fn(),
    getMany: jest.fn(),
    getCount: jest.fn(),
  };
  for (const method of ['andWhere', 'orderBy', 'skip', 'take'] as const) {
    query[method].mockReturnValue(query);
  }
  return query;
}

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
