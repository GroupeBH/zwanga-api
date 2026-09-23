import { BadRequestException } from '@nestjs/common';
import { VehiclesService } from './vehicles.service';
import { VehicleType } from './entities/vehicle.entity';
import { UserRole } from '../users/entities/user.entity';

describe('VehiclesService vehicle creation', () => {
  let service: VehiclesService;
  let vehicleRepository: {
    create: jest.Mock;
    save: jest.Mock;
    findOne: jest.Mock;
    find: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let userRepository: { findOne: jest.Mock; save: jest.Mock };
  let tripRepository: { find: jest.Mock };
  let cacheService: { get: jest.Mock; set: jest.Mock; del: jest.Mock };

  beforeEach(() => {
    vehicleRepository = {
      create: jest.fn((payload) => payload),
      save: jest.fn((vehicle) =>
        Promise.resolve({ ...vehicle, id: vehicle.id ?? 'vehicle-new' }),
      ),
      findOne: jest.fn(),
      find: jest.fn(),
      createQueryBuilder: jest.fn(),
    };
    userRepository = {
      findOne: jest.fn().mockResolvedValue({
        id: 'owner-1',
        role: UserRole.PASSENGER,
        isDriver: false,
      }),
      save: jest.fn((user) => Promise.resolve(user)),
    };
    tripRepository = {
      find: jest.fn().mockResolvedValue([]),
    };
    cacheService = {
      get: jest.fn(),
      set: jest.fn().mockResolvedValue(undefined),
      del: jest.fn().mockResolvedValue(undefined),
    };

    service = new VehiclesService(
      vehicleRepository as any,
      userRepository as any,
      tripRepository as any,
      cacheService as any,
      { getPresignedUrlIfS3Key: jest.fn() } as any,
    );
  });

  function mockPlateLookup(vehicle: any) {
    const queryBuilder = {
      where: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(vehicle),
    };
    vehicleRepository.createQueryBuilder.mockReturnValue(queryBuilder);
    return queryBuilder;
  }

  it('normalizes the license plate before creating a vehicle', async () => {
    mockPlateLookup(null);

    await service.create('owner-1', {
      type: VehicleType.CAR,
      brand: ' Toyota ',
      model: ' Corolla ',
      color: ' Noir ',
      licensePlate: '1576 an-01',
    } as any);

    expect(vehicleRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        brand: 'Toyota',
        model: 'Corolla',
        color: 'Noir',
        type: VehicleType.CAR,
        licensePlate: '1576AN01',
        ownerId: 'owner-1',
        isActive: true,
      }),
    );
  });

  it('promotes a public owner to a coherent driver profile when creating a vehicle', async () => {
    mockPlateLookup(null);
    const owner = {
      id: 'owner-1',
      role: UserRole.PASSENGER,
      isDriver: false,
    };
    userRepository.findOne.mockResolvedValue(owner);

    await service.create('owner-1', {
      type: VehicleType.CAR,
      brand: 'Toyota',
      model: 'Corolla',
      color: 'Noir',
      licensePlate: '1576AN01',
    } as any);

    expect(userRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        role: UserRole.DRIVER,
        isDriver: true,
      }),
    );
  });

  it('rejects vehicle creation from admin accounts', async () => {
    userRepository.findOne.mockResolvedValue({
      id: 'admin-1',
      role: UserRole.ADMIN,
      isDriver: false,
    });

    await expect(
      service.create('admin-1', {
        type: VehicleType.CAR,
        brand: 'Toyota',
        model: 'Corolla',
        color: 'Noir',
        licensePlate: 'ADMIN001',
      } as any),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(vehicleRepository.save).not.toHaveBeenCalled();
  });

  it('rejects creation when the vehicle type is missing', async () => {
    await expect(
      service.create('owner-1', {
        brand: 'Toyota',
        model: 'Corolla',
        color: 'Noir',
        licensePlate: '1576AN01',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(userRepository.findOne).not.toHaveBeenCalled();
    expect(vehicleRepository.save).not.toHaveBeenCalled();
  });

  it('supports two- and three-wheel motorcycles', async () => {
    mockPlateLookup(null);

    await service.create('owner-1', {
      type: VehicleType.MOTORCYCLE_TWO_WHEELS,
      brand: 'Honda',
      model: 'CB125',
      color: 'Rouge',
      licensePlate: 'MOTO-001',
    } as any);

    expect(vehicleRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        type: VehicleType.MOTORCYCLE_TWO_WHEELS,
      }),
    );

    vehicleRepository.create.mockClear();
    await service.create('owner-1', {
      type: VehicleType.MOTORCYCLE_THREE_WHEELS,
      brand: 'TVS',
      model: 'King',
      color: 'Bleu',
      licensePlate: 'TRIKE-001',
    } as any);

    expect(vehicleRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        type: VehicleType.MOTORCYCLE_THREE_WHEELS,
      }),
    );
  });

  it('rejects a motorcycle type that cannot support an active trip', async () => {
    vehicleRepository.findOne.mockResolvedValue({
      id: 'vehicle-1',
      ownerId: 'owner-1',
      type: VehicleType.CAR,
      brand: 'Toyota',
      model: 'Corolla',
      color: 'Noir',
      licensePlate: '1234AA01',
      isActive: true,
    });
    tripRepository.find.mockResolvedValue([
      {
        id: 'trip-1',
        totalSeats: 3,
        availableSeats: 3,
      },
    ]);

    await expect(
      service.update('vehicle-1', 'owner-1', {
        type: VehicleType.MOTORCYCLE_TWO_WHEELS,
      } as any),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(vehicleRepository.save).not.toHaveBeenCalled();
  });

  it('reactivates and updates an inactive vehicle when the plate already belongs to the same owner', async () => {
    const existingVehicle = {
      id: 'vehicle-1',
      ownerId: 'owner-1',
      brand: 'Old',
      model: 'Old',
      color: 'Old',
      licensePlate: '7453 aq10',
      isActive: false,
    };
    mockPlateLookup(existingVehicle);

    const result = await service.create('owner-1', {
      type: VehicleType.CAR,
      brand: 'Hyundai',
      model: 'Tucson',
      color: 'Blanc',
      licensePlate: '7453-AQ10',
    } as any);

    expect(vehicleRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'vehicle-1',
        ownerId: 'owner-1',
        brand: 'Hyundai',
        model: 'Tucson',
        color: 'Blanc',
        licensePlate: '7453AQ10',
        isActive: true,
      }),
    );
    expect(result.id).toBe('vehicle-1');
  });

  it('rejects a license plate that belongs to another owner', async () => {
    mockPlateLookup({
      id: 'vehicle-2',
      ownerId: 'owner-2',
      licensePlate: '7453AQ10',
      isActive: true,
    });

    await expect(
      service.create('owner-1', {
        type: VehicleType.CAR,
        brand: 'Hyundai',
        model: 'Tucson',
        color: 'Blanc',
        licensePlate: '7453AQ10',
      } as any),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(vehicleRepository.save).not.toHaveBeenCalled();
  });

  it('blocks updating a vehicle to a plate used by another vehicle', async () => {
    vehicleRepository.findOne.mockResolvedValue({
      id: 'vehicle-1',
      ownerId: 'owner-1',
      brand: 'Hyundai',
      model: 'Tucson',
      color: 'Blanc',
      licensePlate: '1234AA01',
      isActive: true,
    });
    mockPlateLookup({
      id: 'vehicle-2',
      ownerId: 'owner-2',
      licensePlate: '7453AQ10',
    });

    await expect(
      service.update('vehicle-1', 'owner-1', {
        licensePlate: '7453 aq10',
      } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('returns a precise error when a vehicle is still used by active trips', async () => {
    vehicleRepository.findOne.mockResolvedValue({
      id: 'vehicle-1',
      ownerId: 'owner-1',
      isActive: true,
    });
    tripRepository.find.mockResolvedValue([{ id: 'trip-1' }]);

    await expect(service.remove('vehicle-1', 'owner-1')).rejects.toMatchObject({
      status: 400,
      response: expect.objectContaining({
        code: 'VEHICLE_HAS_ACTIVE_TRIPS',
      }),
    });

    expect(vehicleRepository.save).not.toHaveBeenCalled();
  });

  it('distinguishes an unavailable vehicle from a technical failure', async () => {
    vehicleRepository.findOne.mockResolvedValue(null);

    await expect(
      service.remove('vehicle-missing', 'owner-1'),
    ).rejects.toMatchObject({
      status: 404,
      response: expect.objectContaining({
        code: 'VEHICLE_NOT_FOUND',
      }),
    });
  });
});
