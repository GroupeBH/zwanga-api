import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Vehicle } from './entities/vehicle.entity';
import { User } from '../users/entities/user.entity';
import { CacheService } from '../common/services/cache.service';

@Injectable()
export class VehiclesService {
  private readonly CACHE_TTL = 600; // 10 minutes

  constructor(
    @InjectRepository(Vehicle)
    private vehicleRepository: Repository<Vehicle>,
    @InjectRepository(User)
    private userRepository: Repository<User>,
    private cacheService: CacheService,
  ) {}

  async create(ownerId: string, vehicleData: Partial<Vehicle>): Promise<Vehicle> {
    const owner = await this.userRepository.findOne({ where: { id: ownerId } });
    if (!owner) {
      throw new NotFoundException('Owner not found');
    }

    const vehicle = this.vehicleRepository.create({
      ...vehicleData,
      ownerId,
    });

    const savedVehicle = await this.vehicleRepository.save(vehicle);
    
    // Invalidate cache
    await this.cacheService.del(CacheService.getVehiclesByOwnerKey(ownerId));

    return savedVehicle;
  }

  async findAllByOwner(ownerId: string): Promise<Vehicle[]> {
    const cacheKey = CacheService.getVehiclesByOwnerKey(ownerId);
    const cached = await this.cacheService.get<Vehicle[]>(cacheKey);
    
    if (cached) {
      return cached;
    }

    const vehicles = await this.vehicleRepository.find({
      where: { ownerId },
      order: { createdAt: 'DESC' },
    });

    await this.cacheService.set(cacheKey, vehicles, this.CACHE_TTL);
    return vehicles;
  }

  async findOne(id: string, ownerId: string): Promise<Vehicle> {
    const cacheKey = CacheService.getVehicleKey(id);
    const cached = await this.cacheService.get<Vehicle>(cacheKey);
    
    if (cached && cached.ownerId === ownerId) {
      return cached;
    }

    const vehicle = await this.vehicleRepository.findOne({
      where: { id, ownerId },
    });

    if (!vehicle) {
      throw new NotFoundException('Vehicle not found');
    }

    await this.cacheService.set(cacheKey, vehicle, this.CACHE_TTL);
    return vehicle;
  }

  async update(id: string, ownerId: string, updateData: Partial<Vehicle>): Promise<Vehicle> {
    const vehicle = await this.findOne(id, ownerId);
    Object.assign(vehicle, updateData);
    const updatedVehicle = await this.vehicleRepository.save(vehicle);
    
    // Invalidate cache
    await this.cacheService.del(CacheService.getVehicleKey(id));
    await this.cacheService.del(CacheService.getVehiclesByOwnerKey(ownerId));

    return updatedVehicle;
  }

  async remove(id: string, ownerId: string): Promise<void> {
    const vehicle = await this.findOne(id, ownerId);
    await this.vehicleRepository.remove(vehicle);
    
    // Invalidate cache
    await this.cacheService.del(CacheService.getVehicleKey(id));
    await this.cacheService.del(CacheService.getVehiclesByOwnerKey(ownerId));
  }
}

