import { Injectable, NotFoundException, Logger, BadRequestException, InternalServerErrorException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, QueryFailedError } from 'typeorm';
import { Vehicle } from './entities/vehicle.entity';
import { User } from '../users/entities/user.entity';
import { Trip, TripStatus } from '../trips/entities/trip.entity';
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
    @InjectRepository(Trip)
    private tripRepository: Repository<Trip>,
    private cacheService: CacheService,
    private fileUploadService: FileUploadService,
  ) {}

  async create(ownerId: string, vehicleData: Partial<Vehicle>): Promise<Vehicle> {
    this.logger.log(`Creating vehicle for owner: ${ownerId} (${vehicleData.brand} ${vehicleData.model})`);
    
    try {
      // Validate required fields
      if (!vehicleData.brand || !vehicleData.model || !vehicleData.color || !vehicleData.licensePlate) {
        const missingFields: string[] = [];
        if (!vehicleData.brand) missingFields.push('brand');
        if (!vehicleData.model) missingFields.push('model');
        if (!vehicleData.color) missingFields.push('color');
        if (!vehicleData.licensePlate) missingFields.push('licensePlate');
        
        this.logger.warn(`Vehicle creation failed: Missing required fields: ${missingFields.join(', ')}`);
        throw new BadRequestException(
          `Champs requis manquants : ${missingFields.join(', ')}`
        );
      }

      // Check if owner exists
      const owner = await this.userRepository.findOne({ where: { id: ownerId } });
      if (!owner) {
        this.logger.warn(`Vehicle creation failed: Owner ${ownerId} not found`);
        throw new NotFoundException('Propriétaire non trouvé');
      }

      // Check if license plate already exists (before attempting save)
      const existingVehicle = await this.vehicleRepository.findOne({
        where: { licensePlate: vehicleData.licensePlate },
      });

      if (existingVehicle) {
        this.logger.warn(
          `Vehicle creation failed: License plate ${vehicleData.licensePlate} already exists (vehicle ID: ${existingVehicle.id})`
        );
        throw new BadRequestException(
          `Cette plaque d'immatriculation (${vehicleData.licensePlate}) est déjà utilisée par un autre véhicule`
        );
      }

      // Create vehicle entity
      const vehicle = this.vehicleRepository.create({
        ...vehicleData,
        ownerId,
        isActive: vehicleData.isActive !== undefined ? vehicleData.isActive : true,
      });

      // Save vehicle to database
      const savedVehicle = await this.vehicleRepository.save(vehicle);
      
      // Invalidate cache (non-blocking, don't fail if cache fails)
      try {
        await this.cacheService.del(CacheService.getVehiclesByOwnerKey(ownerId));
      } catch (cacheError) {
        this.logger.warn(`Failed to invalidate cache for owner ${ownerId}: ${cacheError.message}`);
        // Don't throw, cache invalidation is not critical
      }

      this.logger.log(`Vehicle created successfully: ${savedVehicle.id} for owner ${ownerId}`);
      return savedVehicle;

    } catch (error) {
      // Re-throw known exceptions (BadRequestException, NotFoundException)
      if (error instanceof BadRequestException || error instanceof NotFoundException) {
        throw error;
      }

      // Handle database constraint violations (unique constraint on licensePlate)
      if (error instanceof QueryFailedError) {
        const errorMessage = error.message || '';
        
        // Check for unique constraint violation (PostgreSQL error code 23505)
        if (errorMessage.includes('23505') || errorMessage.includes('unique constraint') || errorMessage.includes('duplicate key')) {
          this.logger.error(
            `Vehicle creation failed: Unique constraint violation for license plate ${vehicleData.licensePlate}`,
            error.stack
          );
          throw new BadRequestException(
            `Cette plaque d'immatriculation (${vehicleData.licensePlate}) est déjà utilisée`
          );
        }

        // Handle other database errors
        this.logger.error(
          `Vehicle creation failed: Database error for owner ${ownerId}`,
          error.stack
        );
        throw new InternalServerErrorException(
          'Erreur lors de la sauvegarde du véhicule dans la base de données'
        );
      }

      // Handle unexpected errors
      this.logger.error(
        `Vehicle creation failed: Unexpected error for owner ${ownerId}`,
        error.stack
      );
      throw new InternalServerErrorException(
        'Une erreur inattendue s\'est produite lors de la création du véhicule'
      );
    }
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
      where: { ownerId, isActive: true },
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
    this.logger.log(`Deactivating vehicle ${id} for owner ${ownerId}`);
    
    const vehicle = await this.findOne(id, ownerId);
    
    // Check if vehicle is associated with active or pending trips
    const activeTrips = await this.tripRepository.find({
      where: {
        vehicleId: id,
        status: In([TripStatus.ACTIVE, TripStatus.PENDING]),
      },
    });

    if (activeTrips.length > 0) {
      this.logger.warn(
        `Vehicle deactivation failed: Vehicle ${id} is associated with ${activeTrips.length} active or pending trip(s)`,
      );
      throw new BadRequestException(
        `Impossible de désactiver ce véhicule. Il est associé à ${activeTrips.length} trajet(s) en cours ou en attente.`,
      );
    }
    
    // Instead of deleting, deactivate the vehicle
    // This allows the vehicle to remain linked to existing trips (completed, cancelled, expired)
    // but prevents it from being used in new trips
    vehicle.isActive = false;
    await this.vehicleRepository.save(vehicle);
    
    // Invalidate cache
    await this.cacheService.del(CacheService.getVehicleKey(id));
    await this.cacheService.del(CacheService.getVehiclesByOwnerKey(ownerId));

    this.logger.log(`Vehicle ${id} deactivated successfully`);
  }
}

