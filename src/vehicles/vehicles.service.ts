import {
  Injectable,
  NotFoundException,
  Logger,
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import {
  getVehicleMaxSeats,
  Vehicle,
  VehicleType,
} from './entities/vehicle.entity';
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

  private normalizeVehiclePayload(
    vehicleData: Partial<Vehicle>,
  ): Partial<Vehicle> {
    return {
      ...vehicleData,
      brand: vehicleData.brand?.trim(),
      model: vehicleData.model?.trim(),
      color: vehicleData.color?.trim(),
      licensePlate: vehicleData.licensePlate?.trim().toUpperCase(),
    };
  }

  private async invalidateOwnerVehiclesCache(ownerId: string): Promise<void> {
    try {
      await this.cacheService.del(CacheService.getVehiclesByOwnerKey(ownerId));
    } catch (cacheError: any) {
      this.logger.warn(
        `Failed to invalidate cache for owner ${ownerId}: ${cacheError.message}`,
      );
    }
  }

  async create(
    ownerId: string,
    vehicleData: Partial<Vehicle>,
  ): Promise<Vehicle> {
    this.logger.log(
      `Creating vehicle for owner: ${ownerId} (${vehicleData.brand} ${vehicleData.model})`,
    );

    const sanitizedVehicleData = this.sanitizeVehicleData(vehicleData);
    const normalizedLicensePlate = sanitizedVehicleData.licensePlate;

    try {
      if (
        !sanitizedVehicleData.brand ||
        !sanitizedVehicleData.model ||
        !sanitizedVehicleData.color ||
        !normalizedLicensePlate
      ) {
        const missingFields: string[] = [];
        if (!sanitizedVehicleData.brand) missingFields.push('brand');
        if (!sanitizedVehicleData.model) missingFields.push('model');
        if (!sanitizedVehicleData.color) missingFields.push('color');
        if (!normalizedLicensePlate) missingFields.push('licensePlate');

        this.logger.warn(
          `Vehicle creation failed: Missing required fields: ${missingFields.join(', ')}`,
        );
        throw new BadRequestException(
          `Champs requis manquants : ${missingFields.join(', ')}`,
        );
      }

      const owner = await this.userRepository.findOne({
        where: { id: ownerId },
      });
      if (!owner) {
        this.logger.warn(`Vehicle creation failed: Owner ${ownerId} not found`);
        throw new NotFoundException('Proprietaire non trouve');
      }

      const existingVehicle = await this.findByNormalizedLicensePlate(
        normalizedLicensePlate,
      );

      if (existingVehicle) {
        if (existingVehicle.ownerId === ownerId) {
          return this.reactivateOrUpdateExistingVehicle(
            existingVehicle,
            ownerId,
            sanitizedVehicleData,
            normalizedLicensePlate,
          );
        }

        this.logger.warn(
          `Vehicle creation failed: License plate ${normalizedLicensePlate} already exists (vehicle ID: ${existingVehicle.id}, owner: ${existingVehicle.ownerId})`,
        );
        throw new BadRequestException(
          `Cette plaque d'immatriculation (${normalizedLicensePlate}) est deja utilisee par un autre vehicule`,
        );
      }

      const vehicle = this.vehicleRepository.create({
        ...sanitizedVehicleData,
        ownerId,
        type: sanitizedVehicleData.type ?? VehicleType.CAR,
        isActive:
          sanitizedVehicleData.isActive !== undefined
            ? sanitizedVehicleData.isActive
            : true,
      });

      const savedVehicle = await this.vehicleRepository.save(vehicle);
      await this.invalidateVehicleCaches(ownerId);

      this.logger.log(
        `Vehicle created successfully: ${savedVehicle.id} for owner ${ownerId}`,
      );
      return savedVehicle;
    } catch (error) {
      if (
        error instanceof BadRequestException ||
        error instanceof NotFoundException
      ) {
        throw error;
      }

      if (this.isUniqueConstraintError(error)) {
        const existingVehicle = await this.findByNormalizedLicensePlate(
          normalizedLicensePlate ?? vehicleData.licensePlate ?? '',
        );
        if (existingVehicle?.ownerId === ownerId) {
          return this.reactivateOrUpdateExistingVehicle(
            existingVehicle,
            ownerId,
            sanitizedVehicleData,
            existingVehicle.licensePlate,
          );
        }

        this.logger.error(
          `Vehicle creation failed: Unique constraint violation for license plate ${normalizedLicensePlate}`,
          error instanceof Error ? error.stack : undefined,
        );
        throw new BadRequestException(
          `Cette plaque d'immatriculation (${normalizedLicensePlate}) est deja utilisee par un autre vehicule`,
        );
      }

      this.logger.error(
        `Vehicle creation failed: Unexpected error for owner ${ownerId}`,
        error instanceof Error ? error.stack : undefined,
      );
      throw new InternalServerErrorException(
        "Une erreur inattendue s'est produite lors de la creation du vehicule",
      );
    }
  }

  async findAllByOwner(ownerId: string): Promise<Vehicle[]> {
    this.logger.debug(`Fetching vehicles for owner: ${ownerId}`);

    const cacheKey = CacheService.getVehiclesByOwnerKey(ownerId);
    const cached = await this.cacheService.get<Vehicle[]>(cacheKey);

    if (cached) {
      this.logger.debug(
        `Returning ${cached.length} vehicles from cache for owner ${ownerId}`,
      );
      return Promise.all(
        cached.map((vehicle) => this.enrichVehiclePhotoUrl(vehicle)),
      );
    }

    const vehicles = await this.vehicleRepository.find({
      where: { ownerId, isActive: true },
      order: { createdAt: 'DESC' },
    });

    await this.cacheService.set(cacheKey, vehicles, this.CACHE_TTL);

    const enrichedVehicles = await Promise.all(
      vehicles.map((vehicle) => this.enrichVehiclePhotoUrl(vehicle)),
    );

    this.logger.debug(
      `Fetched ${vehicles.length} vehicles from database for owner ${ownerId}`,
    );
    return enrichedVehicles;
  }

  async findOne(id: string, ownerId: string): Promise<Vehicle> {
    this.logger.debug(`Fetching vehicle ${id} for owner ${ownerId}`);

    const cacheKey = CacheService.getVehicleKey(id);
    const cached = await this.cacheService.get<Vehicle>(cacheKey);

    if (cached && cached.ownerId === ownerId) {
      this.logger.debug(`Vehicle ${id} returned from cache`);
      return this.enrichVehiclePhotoUrl(cached);
    }

    const vehicle = await this.findOwnedVehicleEntity(id, ownerId);

    await this.cacheService.set(cacheKey, vehicle, this.CACHE_TTL);

    this.logger.debug(`Vehicle ${id} fetched from database`);
    return this.enrichVehiclePhotoUrl(vehicle);
  }

  async update(
    id: string,
    ownerId: string,
    updateData: Partial<Vehicle>,
  ): Promise<Vehicle> {
    this.logger.log(`Updating vehicle ${id} for owner ${ownerId}`);

    const vehicle = await this.findOwnedVehicleEntity(id, ownerId);
    const sanitizedUpdateData = this.sanitizeVehicleData(updateData);

    if (updateData.licensePlate !== undefined) {
      const normalizedLicensePlate = sanitizedUpdateData.licensePlate;
      if (!normalizedLicensePlate) {
        throw new BadRequestException(
          "La plaque d'immatriculation est requise",
        );
      }

      const existingVehicle = await this.findByNormalizedLicensePlate(
        normalizedLicensePlate,
      );
      if (existingVehicle && existingVehicle.id !== id) {
        throw new BadRequestException(
          `Cette plaque d'immatriculation (${normalizedLicensePlate}) est deja utilisee par un autre vehicule`,
        );
      }
    }

    const nextType =
      sanitizedUpdateData.type ?? vehicle.type ?? VehicleType.CAR;
    if (nextType !== (vehicle.type ?? VehicleType.CAR)) {
      await this.ensureTypeSupportsActiveTrips(id, nextType);
    }

    Object.assign(vehicle, sanitizedUpdateData, { type: nextType });

    let updatedVehicle: Vehicle;
    try {
      updatedVehicle = await this.vehicleRepository.save(vehicle);
    } catch (error) {
      if (this.isUniqueConstraintError(error)) {
        throw new BadRequestException(
          `Cette plaque d'immatriculation (${vehicle.licensePlate}) est deja utilisee par un autre vehicule`,
        );
      }
      throw error;
    }

    await this.invalidateVehicleCaches(ownerId, id);

    this.logger.log(`Vehicle ${id} updated successfully`);
    return this.enrichVehiclePhotoUrl(updatedVehicle);
  }

  async remove(id: string, ownerId: string): Promise<void> {
    this.logger.log(`Deactivating vehicle ${id} for owner ${ownerId}`);

    const vehicle = await this.findOwnedVehicleEntity(id, ownerId);

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
        `Impossible de desactiver ce vehicule. Il est associe a ${activeTrips.length} trajet(s) en cours ou en attente.`,
      );
    }

    vehicle.isActive = false;
    await this.vehicleRepository.save(vehicle);

    await this.invalidateVehicleCaches(ownerId, id);

    this.logger.log(`Vehicle ${id} deactivated successfully`);
  }

  private async findOwnedVehicleEntity(
    id: string,
    ownerId: string,
  ): Promise<Vehicle> {
    const vehicle = await this.vehicleRepository.findOne({
      where: { id, ownerId },
    });

    if (!vehicle) {
      this.logger.warn(`Vehicle not found: ${id} for owner ${ownerId}`);
      throw new NotFoundException('Vehicle not found');
    }

    return vehicle;
  }

  private async enrichVehiclePhotoUrl(vehicle: Vehicle): Promise<Vehicle> {
    const enriched = { ...vehicle };
    if (enriched.photoUrl) {
      enriched.photoUrl =
        (await this.fileUploadService.getPresignedUrlIfS3Key(
          enriched.photoUrl,
        )) || enriched.photoUrl;
    }
    return enriched as Vehicle;
  }

  private sanitizeVehicleData(vehicleData: Partial<Vehicle>): Partial<Vehicle> {
    const sanitized: Partial<Vehicle> = { ...vehicleData };

    if (vehicleData.brand !== undefined) {
      sanitized.brand = vehicleData.brand.trim();
    }
    if (vehicleData.model !== undefined) {
      sanitized.model = vehicleData.model.trim();
    }
    if (vehicleData.color !== undefined) {
      sanitized.color = vehicleData.color.trim();
    }
    if (vehicleData.licensePlate !== undefined) {
      sanitized.licensePlate = this.normalizeLicensePlate(
        vehicleData.licensePlate,
      );
    }
    if (vehicleData.photoUrl !== undefined) {
      const photoUrl = vehicleData.photoUrl.trim();
      sanitized.photoUrl = photoUrl || undefined;
    }

    return sanitized;
  }

  private normalizeLicensePlate(licensePlate?: string | null): string {
    return (licensePlate ?? '')
      .trim()
      .toUpperCase()
      .replace(/[\s-]+/g, '');
  }

  private async findByNormalizedLicensePlate(
    licensePlate: string,
  ): Promise<Vehicle | null> {
    const normalizedLicensePlate = this.normalizeLicensePlate(licensePlate);
    if (!normalizedLicensePlate) {
      return null;
    }

    return this.vehicleRepository
      .createQueryBuilder('vehicle')
      .where(
        "UPPER(REPLACE(REPLACE(vehicle.\"licensePlate\", ' ', ''), '-', '')) = :licensePlate",
        { licensePlate: normalizedLicensePlate },
      )
      .getOne();
  }

  private async reactivateOrUpdateExistingVehicle(
    vehicle: Vehicle,
    ownerId: string,
    vehicleData: Partial<Vehicle>,
    normalizedLicensePlate: string,
  ): Promise<Vehicle> {
    this.logger.log(
      `Vehicle with license plate ${normalizedLicensePlate} already belongs to owner ${ownerId}; reactivating/updating vehicle ${vehicle.id}`,
    );

    const nextType = vehicleData.type ?? vehicle.type ?? VehicleType.CAR;
    if (nextType !== (vehicle.type ?? VehicleType.CAR)) {
      await this.ensureTypeSupportsActiveTrips(vehicle.id, nextType);
    }

    vehicle.brand = vehicleData.brand ?? vehicle.brand;
    vehicle.model = vehicleData.model ?? vehicle.model;
    vehicle.color = vehicleData.color ?? vehicle.color;
    vehicle.type = nextType;
    vehicle.licensePlate = normalizedLicensePlate;
    vehicle.photoUrl = vehicleData.photoUrl ?? vehicle.photoUrl;
    vehicle.isActive = true;

    const savedVehicle = await this.vehicleRepository.save(vehicle);
    await this.invalidateVehicleCaches(ownerId, vehicle.id);
    return savedVehicle;
  }

  private async ensureTypeSupportsActiveTrips(
    vehicleId: string,
    vehicleType: VehicleType,
  ): Promise<void> {
    const maxSeats = getVehicleMaxSeats(vehicleType);
    if (maxSeats === null) {
      return;
    }

    const activeTrips = await this.tripRepository.find({
      where: {
        vehicleId,
        status: In([TripStatus.ACTIVE, TripStatus.PENDING]),
      },
    });
    const incompatibleTrip = (activeTrips ?? []).find(
      (trip) => (trip.totalSeats ?? trip.availableSeats) > maxSeats,
    );

    if (incompatibleTrip) {
      throw new BadRequestException(
        `Impossible de changer le type du vehicule : le trajet ${incompatibleTrip.id} depasse la limite de ${maxSeats} places`,
      );
    }
  }

  private async invalidateVehicleCaches(
    ownerId: string,
    vehicleId?: string,
  ): Promise<void> {
    try {
      if (vehicleId) {
        await this.cacheService.del(CacheService.getVehicleKey(vehicleId));
      }
      await this.cacheService.del(CacheService.getVehiclesByOwnerKey(ownerId));
    } catch (cacheError) {
      const message =
        cacheError instanceof Error ? cacheError.message : String(cacheError);
      this.logger.warn(
        `Failed to invalidate vehicle cache for owner ${ownerId}: ${message}`,
      );
    }
  }

  private isUniqueConstraintError(error: unknown): boolean {
    const queryError = error as {
      code?: string;
      message?: string;
      driverError?: { code?: string; message?: string };
    };
    const code = queryError?.code ?? queryError?.driverError?.code;
    const message = `${queryError?.message ?? ''} ${
      queryError?.driverError?.message ?? ''
    }`;

    return (
      code === '23505' ||
      message.includes('23505') ||
      message.includes('unique constraint') ||
      message.includes('duplicate key')
    );
  }
}
