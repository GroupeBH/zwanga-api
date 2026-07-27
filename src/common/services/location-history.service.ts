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
  private readonly DUPLICATE_LOCATION_DISTANCE_METERS = 3;
  private readonly DUPLICATE_LOCATION_WINDOW_MS = 20_000;

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
      if (this.isDuplicateCurrentLocation(existing?.current, current)) {
        await this.redisService.set(
          key,
          {
            previous: existing?.previous ?? null,
            current,
          },
          this.LOCATION_HISTORY_TTL_SECONDS,
        );
        return;
      }

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

  private isDuplicateCurrentLocation(
    previous: TrackedLocationPoint | null | undefined,
    current: TrackedLocationPoint,
  ): boolean {
    if (!previous) {
      return false;
    }

    const previousTimestamp = new Date(previous.recordedAt).getTime();
    const currentTimestamp = new Date(current.recordedAt).getTime();
    if (
      !Number.isFinite(previousTimestamp) ||
      !Number.isFinite(currentTimestamp) ||
      Math.abs(currentTimestamp - previousTimestamp) >
        this.DUPLICATE_LOCATION_WINDOW_MS
    ) {
      return false;
    }

    return (
      this.calculateDistanceMeters(previous, current) <=
      this.DUPLICATE_LOCATION_DISTANCE_METERS
    );
  }

  private calculateDistanceMeters(
    first: TrackedLocationPoint,
    second: TrackedLocationPoint,
  ): number {
    const earthRadiusMeters = 6371000;
    const toRadians = (value: number) => (value * Math.PI) / 180;
    const deltaLatitude = toRadians(second.latitude - first.latitude);
    const deltaLongitude = toRadians(second.longitude - first.longitude);
    const firstLatitude = toRadians(first.latitude);
    const secondLatitude = toRadians(second.latitude);
    const haversine =
      Math.sin(deltaLatitude / 2) * Math.sin(deltaLatitude / 2) +
      Math.cos(firstLatitude) *
        Math.cos(secondLatitude) *
        Math.sin(deltaLongitude / 2) *
        Math.sin(deltaLongitude / 2);

    return (
      earthRadiusMeters *
      2 *
      Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine))
    );
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
