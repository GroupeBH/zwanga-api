import { Injectable, Inject, Logger } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';

@Injectable()
export class CacheService {
  private readonly logger = new Logger(CacheService.name);
  private readonly dirty = new Map<string, number>();
  private generation = 0;
  private disabled = false;
  private lastWarning = 0;

  constructor(
    @Inject(CACHE_MANAGER) private cacheManager: import('cache-manager').Cache,
  ) {}

  async get<T>(key: string): Promise<T | undefined> {
    if (this.disabled) return undefined;
    if (this.dirty.has(key)) await this.evict(key);
    if (this.dirty.has(key)) return undefined;
    const result = await this.attempt(() => this.cacheManager.get<T>(key));
    const value = result.ok ? result.value : undefined;
    if (value) {
      this.logger.debug(`Cache hit: ${key}`);
    } else {
      this.logger.debug(`Cache miss: ${key}`);
    }
    return value;
  }

  async set(key: string, value: any, ttl?: number): Promise<void> {
    this.logger.debug(`Setting cache: ${key} (TTL: ${ttl || 'default'}s)`);
    if (!this.disabled && !this.dirty.has(key))
      await this.attempt(() => this.cacheManager.set(key, value, ttl));
  }

  async del(key: string): Promise<void> {
    this.logger.debug(`Deleting cache: ${key}`);
    await this.evict(key);
    if (key === CacheService.getTripsListKey('all')) {
      await this.evict(CacheService.getTripsListKey('discovery-v2'));
    }
    // Existing booking/payment mutations invalidate the canonical passenger key.
    // Always evict its activity projection too, without changing other cache domains.
    if (/^bookings:passenger:[^:]+$/.test(key)) {
      await this.evict(`${key}:activity`);
    }
  }

  private async evict(key: string): Promise<void> {
    if (this.disabled) return;
    // Bound memory during an outage. Disabling this optional cache is safer
    // than forgetting an invalidation or flushing Redis's authentication keys.
    if (this.dirty.size >= 1000 && !this.dirty.has(key)) {
      this.disabled = true;
      this.dirty.clear();
      this.logger.warn(
        'Read cache disabled until process restart after repeated invalidation failures',
      );
      return;
    }
    const version = ++this.generation;
    this.dirty.set(key, version);
    const result = await this.attempt(() => this.cacheManager.del(key));
    if (result.ok && this.dirty.get(key) === version) this.dirty.delete(key);
  }

  private async attempt<T>(
    operation: () => Promise<T>,
  ): Promise<{ ok: true; value: T } | { ok: false }> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const value = await Promise.race([
        operation(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Read cache deadline exceeded')),
            600,
          );
        }),
      ]);
      return { ok: true, value };
    } catch {
      if (Date.now() - this.lastWarning > 15_000) {
        this.lastWarning = Date.now();
        this.logger.warn(
          'Optional read cache unavailable; using database (security checks remain enforced)',
        );
      }
      return { ok: false };
    } finally {
      if (timer) clearTimeout(timer);
    }
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

  static getBookingsByPassengerActivityKey(passengerId: string): string {
    return `${CacheService.getBookingsByPassengerKey(passengerId)}:activity`;
  }

  static getNotificationKey(userId: string): string {
    return `notifications:user:${userId}`;
  }
}
