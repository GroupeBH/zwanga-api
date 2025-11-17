import { Injectable, Inject, Logger } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';

@Injectable()
export class CacheService {
  private readonly logger = new Logger(CacheService.name);

  constructor(@Inject(CACHE_MANAGER) private cacheManager: import('cache-manager').Cache) {}

  async get<T>(key: string): Promise<T | undefined> {
    const value = await this.cacheManager.get<T>(key);
    if (value) {
      this.logger.debug(`Cache hit: ${key}`);
    } else {
      this.logger.debug(`Cache miss: ${key}`);
    }
    return value;
  }

  async set(key: string, value: any, ttl?: number): Promise<void> {
    this.logger.debug(`Setting cache: ${key} (TTL: ${ttl || 'default'}s)`);
    await this.cacheManager.set(key, value, ttl);
  }

  async del(key: string): Promise<void> {
    this.logger.debug(`Deleting cache: ${key}`);
    await this.cacheManager.del(key);
  }

  async reset(): Promise<void> {
    this.logger.warn('Resetting all cache');
    await this.cacheManager.reset();
  }

  // Helper methods for cache keys
  static getTripKey(id: string): string {
    return `trip:${id}`;
  }

  static getTripsListKey(filters?: string): string {
    return filters ? `trips:list:${filters}` : 'trips:list:all';
  }

  static getVehicleKey(id: string): string {
    return `vehicle:${id}`;
  }

  static getVehiclesByOwnerKey(ownerId: string): string {
    return `vehicles:owner:${ownerId}`;
  }

  static getBookingKey(id: string): string {
    return `booking:${id}`;
  }

  static getBookingsByTripKey(tripId: string): string {
    return `bookings:trip:${tripId}`;
  }

  static getBookingsByPassengerKey(passengerId: string): string {
    return `bookings:passenger:${passengerId}`;
  }

  static getNotificationKey(userId: string): string {
    return `notifications:user:${userId}`;
  }
}

