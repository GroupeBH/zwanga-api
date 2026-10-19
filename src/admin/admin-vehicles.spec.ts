import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  ValidationPipe,
} from '@nestjs/common';
import { UserRole, UserStatus } from '../users/entities/user.entity';
import { VehicleType } from '../vehicles/entities/vehicle.entity';
import { AdminVehiclesService } from './admin-vehicles.service';
import {
  AdminUpdateVehicleDto,
  AdminVehiclesQueryDto,
} from './dto/admin-vehicles.dto';

describe('admin vehicle input validation', () => {
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    transformOptions: { enableImplicitConversion: true },
  });
  const query = (value: unknown) =>
    pipe.transform(value, { type: 'query', metatype: AdminVehiclesQueryDto });
  const body = (value: unknown) =>
    pipe.transform(value, { type: 'body', metatype: AdminUpdateVehicleDto });

  it('defaults to a bounded page and accepts all three types and inactive filtering', async () => {
    expect(await query({})).toEqual(
      expect.objectContaining({ page: 1, limit: 25 }),
    );
    for (const type of Object.values(VehicleType)) {
      expect(
        await query({
          page: '2',
          limit: '200',
          vehicleType: type,
          isActive: 'false',
        }),
      ).toEqual(
        expect.objectContaining({
          page: 2,
          limit: 200,
          vehicleType: type,
          isActive: 'false',
        }),
      );
    }
  });

  it.each([
    { page: '0' },
    { page: '1.5' },
    { page: 'Infinity' },
    { page: ['1', '2'] },
    { limit: '0' },
    { limit: '201' },
    { vehicleType: 'truck' },
    { vehicleType: ['car'] },
    { vehicleType: null },
    { isActive: 'all' },
    { isActive: true },
    { isActive: ['false'] },
    { unknown: 'value' },
  ])('rejects malformed list filters %j', async (value) => {
    await expect(query(value)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('preserves JSON false despite global implicit conversion and trims editable text', async () => {
    expect(await body({ brand: ' Toyota ', isActive: false })).toEqual(
      expect.objectContaining({ brand: 'Toyota', isActive: false }),
    );
  });

  it.each([
    { brand: '  ' },
    { model: null },
    { color: 123 },
    { licensePlate: '' },
    { type: 'truck' },
    { type: null },
    { photoUrl: null },
    { brand: 'x'.repeat(101) },
    { photoUrl: 'x'.repeat(2049) },
    { isActive: 'false' },
    { isActive: 'true' },
    { isActive: 0 },
    { isActive: null },
    { ownerId: 'other-owner' },
    { id: 'other-vehicle' },
    { createdAt: '2026-10-19' },
  ])('rejects malformed or privileged patch fields %j', async (value) => {
    await expect(body(value)).rejects.toBeInstanceOf(BadRequestException);
  });
});

function fixture() {
  const query = {
    leftJoin: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    addOrderBy: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
    getOne: jest.fn(),
  };
  const vehicles = { createQueryBuilder: jest.fn().mockReturnValue(query) };
  const users = {
    findOne: jest
      .fn()
      .mockResolvedValue({
        id: 'admin',
        role: UserRole.ADMIN,
        isActive: true,
        status: UserStatus.ACTIVE,
        passwordChangeRequired: false,
      }),
  };
  const operations = {
    update: jest.fn(),
    remove: jest.fn().mockResolvedValue(undefined),
  };
  const files = {
    getPresignedUrlIfS3Key: jest.fn(async (key) =>
      key ? 'https://example.test/signed-photo' : null,
    ),
  };
  const vehicle = {
    id: 'vehicle',
    ownerId: 'owner',
    type: VehicleType.CAR,
    brand: 'Test',
    model: 'Test',
    color: 'Blue',
    licensePlate: 'TEST01',
    isActive: true,
    photoUrl: 'vehicles/test.jpg',
    createdAt: new Date(),
    updatedAt: new Date(),
    owner: {
      id: 'owner',
      firstName: 'Synthetic',
      role: UserRole.DRIVER,
      password: 'never-expose',
      accessToken: 'secret',
      refreshToken: 'secret',
      fcmToken: 'secret',
    },
  };
  query.getOne.mockResolvedValue(vehicle);
  operations.update.mockImplementation(async (_id, _owner, patch) => ({
    ...vehicle,
    ...patch,
  }));
  const service = new AdminVehiclesService(
    vehicles as any,
    users as any,
    operations as any,
    files as any,
  );
  return { service, query, vehicles, users, operations, files, vehicle };
}

describe('AdminVehiclesService', () => {
  it('lists all states by default with stable pagination and no sensitive owner fields', async () => {
    const f = fixture();
    f.query.getManyAndCount.mockResolvedValue([[f.vehicle], 5]);
    const result = await f.service.list('admin', { page: 2, limit: 2 });
    expect(f.query.andWhere).not.toHaveBeenCalled();
    expect(f.query.skip).toHaveBeenCalledWith(2);
    expect(f.query.take).toHaveBeenCalledWith(2);
    expect(f.query.orderBy).toHaveBeenCalledWith('vehicle.createdAt', 'DESC');
    expect(f.query.addOrderBy).toHaveBeenCalledWith('vehicle.id', 'DESC');
    expect(result).toEqual(
      expect.objectContaining({ total: 5, page: 2, limit: 2 }),
    );
    expect(result.vehicles[0].photoUrl).toBe(
      'https://example.test/signed-photo',
    );
    expect(result.vehicles[0].owner?.id).toBe('owner');
    expect(JSON.stringify(result)).not.toMatch(
      /never-expose|accessToken|refreshToken|fcmToken|password/,
    );
    expect(f.query.addSelect.mock.calls[0][0]).not.toEqual(
      expect.arrayContaining(['owner.password', 'owner.fcmToken']),
    );
  });

  it.each(['true', 'false'] as const)(
    'combines type and activity filters with bound values: %s',
    async (isActive) => {
      const f = fixture();
      await f.service.list('admin', {
        page: 1,
        limit: 25,
        vehicleType: VehicleType.MOTORCYCLE_TWO_WHEELS,
        isActive,
      });
      expect(f.query.andWhere).toHaveBeenCalledWith(
        'vehicle.type = :vehicleType',
        { vehicleType: VehicleType.MOTORCYCLE_TWO_WHEELS },
      );
      expect(f.query.andWhere).toHaveBeenCalledWith(
        'vehicle.isActive = :isActive',
        { isActive: isActive === 'true' },
      );
    },
  );

  it('allows a super admin and details for inactive vehicles', async () => {
    const f = fixture();
    f.users.findOne.mockResolvedValue({
      role: UserRole.SUPER_ADMIN,
      isActive: true,
    });
    f.vehicle.isActive = false;
    expect(await f.service.get('root', 'vehicle')).toEqual(
      expect.objectContaining({ id: 'vehicle', isActive: false }),
    );
  });

  it.each([
    null,
    { role: UserRole.PASSENGER, isActive: true },
    { role: UserRole.DRIVER, isActive: true },
    { role: UserRole.MARKETER, isActive: true },
    { role: UserRole.ADMIN, isActive: false },
    { role: UserRole.ADMIN, isActive: true, status: UserStatus.SUSPENDED },
    { role: UserRole.ADMIN, isActive: true, status: UserStatus.INACTIVE },
    { role: UserRole.ADMIN, isActive: true, passwordChangeRequired: true },
  ])(
    'denies all operations before vehicle access for unauthorized actor %j',
    async (actor) => {
      const f = fixture();
      f.users.findOne.mockResolvedValue(actor);
      for (const operation of [
        () => f.service.list('actor', new AdminVehiclesQueryDto()),
        () => f.service.get('actor', 'vehicle'),
        () => f.service.update('actor', 'vehicle', { color: 'White' }),
        () => f.service.deactivate('actor', 'vehicle'),
      ]) {
        await expect(operation()).rejects.toBeInstanceOf(ForbiddenException);
      }
      expect(f.vehicles.createQueryBuilder).not.toHaveBeenCalled();
      expect(f.operations.update).not.toHaveBeenCalled();
      expect(f.operations.remove).not.toHaveBeenCalled();
    },
  );

  it('uses the database owner and a field allowlist for edits', async () => {
    const f = fixture();
    const result = await f.service.update('admin', 'vehicle', {
      color: 'White',
      ownerId: 'attacker',
      id: 'other',
    } as any);
    expect(f.operations.update).toHaveBeenCalledWith('vehicle', 'owner', {
      color: 'White',
    });
    expect(result.color).toBe('White');
    expect(result.ownerId).toBe('owner');
  });

  it('refuses an empty patch and preserves existing trip conflicts on both deactivation paths', async () => {
    const f = fixture();
    await expect(
      f.service.update('admin', 'vehicle', {}),
    ).rejects.toBeInstanceOf(BadRequestException);
    const conflict = new BadRequestException({
      code: 'VEHICLE_HAS_ACTIVE_TRIPS',
    });
    f.operations.remove.mockRejectedValue(conflict);
    f.operations.update.mockRejectedValue(conflict);
    await expect(f.service.deactivate('admin', 'vehicle')).rejects.toBe(
      conflict,
    );
    await expect(
      f.service.update('admin', 'vehicle', { isActive: false }),
    ).rejects.toBe(conflict);
  });

  it('deactivation delegates to the existing soft-delete flow, not physical deletion', async () => {
    const f = fixture();
    expect(await f.service.deactivate('admin', 'vehicle')).toEqual(
      expect.objectContaining({ id: 'vehicle', isActive: false }),
    );
    expect(f.operations.remove).toHaveBeenCalledWith('vehicle', 'owner');
    expect(f.operations.update).not.toHaveBeenCalled();
  });

  it('returns 404 for missing vehicles and never invokes a mutation', async () => {
    const f = fixture();
    f.query.getOne.mockResolvedValue(null);
    for (const call of [
      () => f.service.get('admin', 'missing'),
      () => f.service.update('admin', 'missing', { color: 'White' }),
      () => f.service.deactivate('admin', 'missing'),
    ]) {
      await expect(call()).rejects.toBeInstanceOf(NotFoundException);
    }
    expect(f.operations.update).not.toHaveBeenCalled();
    expect(f.operations.remove).not.toHaveBeenCalled();
  });
});
