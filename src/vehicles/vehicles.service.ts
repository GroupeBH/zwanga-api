import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Vehicle } from './entities/vehicle.entity';
import { User } from '../users/entities/user.entity';
import { CacheService } from '../common/services/cache.service';
import { FileUploadService } from '../common/services/file-upload.service';

@Injectable()
export class VehiclesService {
  private readonly logger = new Logger(VehiclesService.name);
  private readonly CACHE_TTL = 600; // 10 minutes

  constructor(
    @InjectRepository(Vehicle)
    private vehicleRepository: Repository<Vehicle>,
    @InjectRepository(User)
    private userRepository: Repository<User>,
    private cacheService: CacheService,
    private fileUploadService: FileUploadService,
  ) {}

  async create(ownerId: string, vehicleData: Partial<Vehicle>): Promise<Vehicle> {
    this.logger.log(`Creating vehicle for owner: ${ownerId} (${vehicleData.brand} ${vehicleData.model})`);
    
    const owner = await this.userRepository.findOne({ where: { id: ownerId } });
    if (!owner) {
      this.logger.warn(`Vehicle creation failed: Owner ${ownerId} not found`);
      throw new NotFoundException('Owner not found');
    }

    const vehicle = this.vehicleRepository.create({
      ...vehicleData,
      ownerId,
    });

    const savedVehicle = await this.vehicleRepository.save(vehicle);
    
    // Invalidate cache
    await this.cacheService.del(CacheService.getVehiclesByOwnerKey(ownerId));

    this.logger.log(`Vehicle created successfully: ${savedVehicle.id} for owner ${ownerId}`);
    return savedVehicle;
  }

  async findAllByOwner(ownerId: string): Promise<Vehicle[]> {
    this.logger.debug(`Fetching vehicles for owner: ${ownerId}`);
    
    const cacheKey = CacheService.getVehiclesByOwnerKey(ownerId);
    const cached = await this.cacheService.get<Vehicle[]>(cacheKey);
    
    if (cached) {
      this.logger.debug(`Returning ${cached.length} vehicles from cache for owner ${ownerId}`);
      // Convert S3 keys to presigned URLs even for cached data
      return await Promise.all(
        cached.map(async (vehicle) => {
          const enriched = { ...vehicle };
          if (enriched.photoUrl) {
            enriched.photoUrl = await this.fileUploadService.getPresignedUrlIfS3Key(enriched.photoUrl) || enriched.photoUrl;
          }
          return enriched;
        }),
      );
    }

    const vehicles = await this.vehicleRepository.find({
      where: { ownerId },
      order: { createdAt: 'DESC' },
    });

    // Cache vehicles with S3 keys (not presigned URLs)
    await this.cacheService.set(cacheKey, vehicles, this.CACHE_TTL);
    
    // Convert S3 keys to presigned URLs before returning
    const enrichedVehicles = await Promise.all(
      vehicles.map(async (vehicle) => {
        const enriched = { ...vehicle };
        if (enriched.photoUrl) {
          enriched.photoUrl = await this.fileUploadService.getPresignedUrlIfS3Key(enriched.photoUrl) || enriched.photoUrl;
        }
        return enriched;
      }),
    );

    this.logger.debug(`Fetched ${vehicles.length} vehicles from database for owner ${ownerId}`);
    return enrichedVehicles;
  }

  async findOne(id: string, ownerId: string): Promise<Vehicle> {
    this.logger.debug(`Fetching vehicle ${id} for owner ${ownerId}`);
    
    const cacheKey = CacheService.getVehicleKey(id);
    const cached = await this.cacheService.get<Vehicle>(cacheKey);
    
    if (cached && cached.ownerId === ownerId) {
      this.logger.debug(`Vehicle ${id} returned from cache`);
      // Convert S3 key to presigned URL even for cached data
      const enriched = { ...cached };
      if (enriched.photoUrl) {
        enriched.photoUrl = await this.fileUploadService.getPresignedUrlIfS3Key(enriched.photoUrl) || enriched.photoUrl;
      }
      return enriched;
    }

    const vehicle = await this.vehicleRepository.findOne({
      where: { id, ownerId },
    });

    if (!vehicle) {
      this.logger.warn(`Vehicle not found: ${id} for owner ${ownerId}`);
      throw new NotFoundException('Vehicle not found');
    }

    // Cache vehicle with S3 key (not presigned URL)
    await this.cacheService.set(cacheKey, vehicle, this.CACHE_TTL);
    
    // Convert S3 key to presigned URL before returning
    const enriched = { ...vehicle };
    if (enriched.photoUrl) {
      enriched.photoUrl = await this.fileUploadService.getPresignedUrlIfS3Key(enriched.photoUrl) || enriched.photoUrl;
    }
    
    this.logger.debug(`Vehicle ${id} fetched from database`);
    return enriched;
  }

  async update(id: string, ownerId: string, updateData: Partial<Vehicle>): Promise<Vehicle> {
    this.logger.log(`Updating vehicle ${id} for owner ${ownerId}`);
    
    const vehicle = await this.findOne(id, ownerId);
    Object.assign(vehicle, updateData);
    const updatedVehicle = await this.vehicleRepository.save(vehicle);
    
    // Invalidate cache
    await this.cacheService.del(CacheService.getVehicleKey(id));
    await this.cacheService.del(CacheService.getVehiclesByOwnerKey(ownerId));

    // Convert S3 key to presigned URL before returning
    const enriched = { ...updatedVehicle };
    if (enriched.photoUrl) {
      enriched.photoUrl = await this.fileUploadService.getPresignedUrlIfS3Key(enriched.photoUrl) || enriched.photoUrl;
    }

    this.logger.log(`Vehicle ${id} updated successfully`);
    return enriched;
  }

  async remove(id: string, ownerId: string): Promise<void> {
    this.logger.log(`Removing vehicle ${id} for owner ${ownerId}`);
    
    const vehicle = await this.findOne(id, ownerId);
    await this.vehicleRepository.remove(vehicle);
    
    // Invalidate cache
    await this.cacheService.del(CacheService.getVehicleKey(id));
    await this.cacheService.del(CacheService.getVehiclesByOwnerKey(ownerId));

    this.logger.log(`Vehicle ${id} removed successfully`);
  }
}

