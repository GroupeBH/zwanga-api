import { BadRequestException } from '@nestjs/common';
import { VehiclesService } from './vehicles.service';
import { VehicleType } from './entities/vehicle.entity';

describe('VehiclesService vehicle creation', () => {
  let service: VehiclesService;
  let vehicleRepository: {
    create: jest.Mock;
    save: jest.Mock;
    findOne: jest.Mock;
    find: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let userRepository: { findOne: jest.Mock };
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
      findOne: jest.fn().mockResolvedValue({ id: 'owner-1' }),
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
});
