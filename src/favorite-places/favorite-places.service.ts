import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Not } from 'typeorm';
import type { Point } from 'typeorm';
import { FavoritePlace, FavoritePlaceType } from './entities/favorite-place.entity';
import { CreateFavoritePlaceDto, UpdateFavoritePlaceDto, FavoritePlaceResponse } from './dto/favorite-place.dto';
import { CacheService } from '../common/services/cache.service';

@Injectable()
export class FavoritePlacesService {
  private readonly logger = new Logger(FavoritePlacesService.name);
  private readonly CACHE_TTL = 300; // 5 minutes

  constructor(
    @InjectRepository(FavoritePlace)
    private favoritePlaceRepository: Repository<FavoritePlace>,
    private cacheService: CacheService,
  ) {}

  async create(userId: string, createDto: CreateFavoritePlaceDto): Promise<FavoritePlaceResponse> {
    this.logger.log(`Creating favorite place for user ${userId}: ${createDto.name}`);

    // Build location point
    const location: Point = {
      type: 'Point',
      coordinates: [
        Number(createDto.coordinates.longitude),
        Number(createDto.coordinates.latitude),
      ],
    };

    // If isDefault is true, unset other default places of the same type
    if (createDto.isDefault) {
      await this.favoritePlaceRepository.update(
        {
          userId,
          type: createDto.type || FavoritePlaceType.OTHER,
          isDefault: true,
        },
        { isDefault: false },
      );
    }

    const favoritePlace = this.favoritePlaceRepository.create({
      userId,
      name: createDto.name,
      address: createDto.address,
      location,
      type: createDto.type || FavoritePlaceType.OTHER,
      isDefault: createDto.isDefault || false,
      placeId: createDto.placeId || null,
      notes: createDto.notes?.trim() || null,
    });

    const saved = await this.favoritePlaceRepository.save(favoritePlace);

    // Invalidate cache
    await this.invalidateUserCache(userId);

    this.logger.log(`Favorite place created: ${saved.id} for user ${userId}`);
    return this.toResponse(saved);
  }

  async findAll(userId: string): Promise<FavoritePlaceResponse[]> {
    this.logger.debug(`Fetching favorite places for user: ${userId}`);

    const cacheKey = this.getUserCacheKey(userId);
    const cached = await this.cacheService.get<FavoritePlaceResponse[]>(cacheKey);

    if (cached) {
      this.logger.debug(`Returning ${cached.length} favorite places from cache for user ${userId}`);
      return cached;
    }

    const places = await this.favoritePlaceRepository.find({
      where: { userId },
      order: {
        type: 'ASC',
        isDefault: 'DESC',
        createdAt: 'ASC',
      },
    });

    const response = places.map((place) => this.toResponse(place));

    await this.cacheService.set(cacheKey, response, this.CACHE_TTL);
    this.logger.debug(`Fetched ${places.length} favorite places from database for user ${userId}`);
    return response;
  }

  async findByType(userId: string, type: FavoritePlaceType): Promise<FavoritePlaceResponse[]> {
    this.logger.debug(`Fetching favorite places of type ${type} for user: ${userId}`);

    const places = await this.favoritePlaceRepository.find({
      where: { userId, type },
      order: { isDefault: 'DESC', createdAt: 'ASC' },
      
    });

    return places.map((place) => this.toResponse(place));
  }

  async findDefault(userId: string, type?: FavoritePlaceType): Promise<FavoritePlaceResponse | null> {
    this.logger.debug(`Fetching default favorite place for user: ${userId}, type: ${type || 'any'}`);

    const where: any = { userId, isDefault: true };
    if (type) {
      where.type = type;
    }

    const place = await this.favoritePlaceRepository.findOne({
      where,
      order: { createdAt: 'ASC' },
    });

    return place ? this.toResponse(place) : null;
  }

  async findOne(id: string, userId: string): Promise<FavoritePlaceResponse> {
    this.logger.debug(`Fetching favorite place: ${id} for user: ${userId}`);

    const place = await this.favoritePlaceRepository.findOne({
      where: { id, userId },
    });

    if (!place) {
      this.logger.warn(`Favorite place not found: ${id} for user ${userId}`);
      throw new NotFoundException('Lieu favori non trouvé');
    }

    return this.toResponse(place);
  }

  async update(
    id: string,
    userId: string,
    updateDto: UpdateFavoritePlaceDto,
  ): Promise<FavoritePlaceResponse> {
    this.logger.log(`Updating favorite place ${id} for user ${userId}`);

    const place = await this.favoritePlaceRepository.findOne({
      where: { id, userId },
    });

    if (!place) {
      this.logger.warn(`Update failed: Favorite place ${id} not found for user ${userId}`);
      throw new NotFoundException('Lieu favori non trouvé');
    }

    // If isDefault is being set to true, unset other default places of the same type
    if (updateDto.isDefault === true) {
      const typeToUpdate = updateDto.type || place.type;
      await this.favoritePlaceRepository.update(
        {
          userId,
          type: typeToUpdate,
          isDefault: true,
          id: Not(id), // Exclude current place
        },
        { isDefault: false },
      );
    }

    // Update location if coordinates are provided
    if (updateDto.coordinates) {
      place.location = {
        type: 'Point',
        coordinates: [
          Number(updateDto.coordinates.longitude),
          Number(updateDto.coordinates.latitude),
        ],
      };
    }

    // Update other fields
    if (updateDto.name !== undefined) place.name = updateDto.name;
    if (updateDto.address !== undefined) place.address = updateDto.address;
    if (updateDto.type !== undefined) place.type = updateDto.type;
    if (updateDto.isDefault !== undefined) place.isDefault = updateDto.isDefault;
    if (updateDto.placeId !== undefined) place.placeId = updateDto.placeId;
    if (updateDto.notes !== undefined) place.notes = updateDto.notes?.trim() || null;

    const saved = await this.favoritePlaceRepository.save(place);

    // Invalidate cache
    await this.invalidateUserCache(userId);

    this.logger.log(`Favorite place updated: ${saved.id} for user ${userId}`);
    return this.toResponse(saved);
  }

  async remove(id: string, userId: string): Promise<void> {
    this.logger.log(`Deleting favorite place ${id} for user ${userId}`);

    const place = await this.favoritePlaceRepository.findOne({
      where: { id, userId },
    });

    if (!place) {
      this.logger.warn(`Delete failed: Favorite place ${id} not found for user ${userId}`);
      throw new NotFoundException('Lieu favori non trouvé');
    }

    await this.favoritePlaceRepository.remove(place);

    // Invalidate cache
    await this.invalidateUserCache(userId);

    this.logger.log(`Favorite place deleted: ${id} for user ${userId}`);
  }

  async setAsDefault(id: string, userId: string): Promise<FavoritePlaceResponse> {
    this.logger.log(`Setting favorite place ${id} as default for user ${userId}`);

    const place = await this.favoritePlaceRepository.findOne({
      where: { id, userId },
    });

    if (!place) {
      this.logger.warn(`Set default failed: Favorite place ${id} not found for user ${userId}`);
      throw new NotFoundException('Lieu favori non trouvé');
    }

    // Unset other default places of the same type
    await this.favoritePlaceRepository.update(
      {
        userId,
        type: place.type,
        isDefault: true,
        id: { $ne: id } as any,
      },
      { isDefault: false },
    );

    place.isDefault = true;
    const saved = await this.favoritePlaceRepository.save(place);

    // Invalidate cache
    await this.invalidateUserCache(userId);

    this.logger.log(`Favorite place set as default: ${saved.id} for user ${userId}`);
    return this.toResponse(saved);
  }

  private toResponse(place: FavoritePlace): FavoritePlaceResponse {
    return {
      id: place.id,
      name: place.name,
      address: place.address,
      coordinates: {
        latitude: (place.location as any).coordinates[1],
        longitude: (place.location as any).coordinates[0],
      },
      type: place.type,
      isDefault: place.isDefault,
      placeId: place.placeId,
      notes: place.notes,
      createdAt: place.createdAt,
      updatedAt: place.updatedAt,
    };
  }

  private getUserCacheKey(userId: string): string {
    return `favorite_places:user:${userId}`;
  }

  private async invalidateUserCache(userId: string): Promise<void> {
    await this.cacheService.del(this.getUserCacheKey(userId));
  }
}

