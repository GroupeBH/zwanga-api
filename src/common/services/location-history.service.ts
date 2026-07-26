import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from './redis.service';

export interface TrackedLocationPoint {
  latitude: number;
  longitude: number;
  recordedAt: string;
}

export interface LocationHistorySnapshot {
  previous: TrackedLocationPoint | null;
  current: TrackedLocationPoint | null;
}

@Injectable()
export class LocationHistoryService {
  private readonly logger = new Logger(LocationHistoryService.name);
  private readonly LOCATION_HISTORY_TTL_SECONDS = 6 * 60 * 60;

  constructor(private readonly redisService: RedisService) {}

  private getDriverKey(tripId: string) {
    return `tracking:history:driver:${tripId}`;
  }

  private getPassengerKey(bookingId: string) {
    return `tracking:history:passenger:${bookingId}`;
  }

  private normalizePoint(
    latitude: number,
    longitude: number,
    recordedAt: Date,
  ): TrackedLocationPoint | null {
    const safeLatitude = Number(latitude);
    const safeLongitude = Number(longitude);
    if (!Number.isFinite(safeLatitude) || !Number.isFinite(safeLongitude)) {
      return null;
    }

    return {
      latitude: safeLatitude,
      longitude: safeLongitude,
      recordedAt: recordedAt.toISOString(),
    };
  }

  private async recordLocation(
    key: string,
    latitude: number,
    longitude: number,
    recordedAt = new Date(),
  ): Promise<void> {
    const current = this.normalizePoint(latitude, longitude, recordedAt);
    if (!current) {
      return;
    }

    try {
      const existing =
        await this.redisService.get<LocationHistorySnapshot>(key);
      await this.redisService.set(
        key,
        {
          previous: existing?.current ?? existing?.previous ?? null,
          current,
        },
        this.LOCATION_HISTORY_TTL_SECONDS,
      );
    } catch (error) {
      this.logger.warn(
        `Unable to record location history in Redis for ${key}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private async getLocationHistory(
    key: string,
  ): Promise<LocationHistorySnapshot | null> {
    try {
      return await this.redisService.get<LocationHistorySnapshot>(key);
    } catch (error) {
      this.logger.warn(
        `Unable to read location history from Redis for ${key}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }

  async recordDriverLocation(
    tripId: string,
    latitude: number,
    longitude: number,
    recordedAt = new Date(),
  ): Promise<void> {
    await this.recordLocation(
      this.getDriverKey(tripId),
      latitude,
      longitude,
      recordedAt,
    );
  }

  async recordPassengerLocation(
    bookingId: string,
    latitude: number,
    longitude: number,
    recordedAt = new Date(),
  ): Promise<void> {
    await this.recordLocation(
      this.getPassengerKey(bookingId),
      latitude,
      longitude,
      recordedAt,
    );
  }

  async getDriverLocationHistory(
    tripId: string,
  ): Promise<LocationHistorySnapshot | null> {
    return this.getLocationHistory(this.getDriverKey(tripId));
  }

  async getPassengerLocationHistory(
    bookingId: string,
  ): Promise<LocationHistorySnapshot | null> {
    return this.getLocationHistory(this.getPassengerKey(bookingId));
  }
}
