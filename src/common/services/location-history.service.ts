import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from './redis.service';
import { normalizeLatLngCoordinate } from '../utils/tracking-coordinates';
import type { BoardingCandidateSnapshot } from '../../bookings/boarding-detection';

export interface LocationObservationMetadata {
  accuracyMeters?: number | null;
  speedMetersPerSecond?: number | null;
  headingDegrees?: number | null;
}

export interface TrackedLocationPoint {
  latitude: number;
  longitude: number;
  recordedAt: string;
  accuracyMeters: number | null;
  speedMetersPerSecond: number | null;
  headingDegrees: number | null;
}

export interface LocationHistorySnapshot {
  previous: TrackedLocationPoint | null;
  current: TrackedLocationPoint | null;
  samples?: TrackedLocationPoint[];
}

@Injectable()
export class LocationHistoryService {
  private readonly logger = new Logger(LocationHistoryService.name);
  private readonly LOCATION_HISTORY_TTL_SECONDS = 6 * 60 * 60;
  private readonly DUPLICATE_LOCATION_DISTANCE_METERS = 3;
  private readonly DUPLICATE_LOCATION_WINDOW_MS = 20_000;
  private readonly LOCATION_WINDOW_SIZE = 10;

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
    metadata: LocationObservationMetadata = {},
  ): TrackedLocationPoint | null {
    const coordinate = normalizeLatLngCoordinate(latitude, longitude);
    if (!coordinate) {
      return null;
    }

    return {
      latitude: coordinate.latitude,
      longitude: coordinate.longitude,
      recordedAt: recordedAt.toISOString(),
      accuracyMeters: this.normalizeNonNegativeNumber(metadata.accuracyMeters),
      speedMetersPerSecond: this.normalizeNonNegativeNumber(
        metadata.speedMetersPerSecond,
      ),
      headingDegrees: this.normalizeHeading(metadata.headingDegrees),
    };
  }

  private normalizeNonNegativeNumber(value?: number | null): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
      ? value
      : null;
  }

  private normalizeHeading(value?: number | null): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
      ? value % 360
      : null;
  }

  private async recordLocation(
    key: string,
    latitude: number,
    longitude: number,
    recordedAt = new Date(),
    metadata: LocationObservationMetadata = {},
  ): Promise<void> {
    const current = this.normalizePoint(
      latitude,
      longitude,
      recordedAt,
      metadata,
    );
    if (!current) {
      return;
    }

    try {
      const existing =
        await this.redisService.get<LocationHistorySnapshot>(key);
      const existingSamples = this.getSamples(existing);
      const existingCurrentTimestamp = existing?.current
        ? new Date(existing.current.recordedAt).getTime()
        : Number.NEGATIVE_INFINITY;
      const currentTimestamp = new Date(current.recordedAt).getTime();
      if (currentTimestamp < existingCurrentTimestamp) {
        this.logger.debug(
          `Ignoring out-of-order location history update for ${key}`,
        );
        return;
      }

      if (this.isDuplicateCurrentLocation(existing?.current, current)) {
        const samples = [...existingSamples.slice(0, -1), current].slice(
          -this.LOCATION_WINDOW_SIZE,
        );
        await this.redisService.set(
          key,
          {
            previous: samples.at(-2) ?? existing?.previous ?? null,
            current,
            samples,
          },
          this.LOCATION_HISTORY_TTL_SECONDS,
        );
        return;
      }

      const samples = [...existingSamples, current].slice(
        -this.LOCATION_WINDOW_SIZE,
      );
      await this.redisService.set(
        key,
        {
          previous: samples.at(-2) ?? existing?.current ?? null,
          current,
          samples,
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

  private getSamples(
    snapshot?: LocationHistorySnapshot | null,
  ): TrackedLocationPoint[] {
    if (snapshot?.samples?.length) {
      return snapshot.samples;
    }
    return [snapshot?.previous, snapshot?.current].filter(
      (sample): sample is TrackedLocationPoint => Boolean(sample),
    );
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
    metadata: LocationObservationMetadata = {},
  ): Promise<void> {
    await this.recordLocation(
      this.getDriverKey(tripId),
      latitude,
      longitude,
      recordedAt,
      metadata,
    );
  }

  async recordPassengerLocation(
    bookingId: string,
    latitude: number,
    longitude: number,
    recordedAt = new Date(),
    metadata: LocationObservationMetadata = {},
  ): Promise<void> {
    await this.recordLocation(
      this.getPassengerKey(bookingId),
      latitude,
      longitude,
      recordedAt,
      metadata,
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

  private getBoardingCandidateKey(
    tripId: string,
    driverId: string,
    passengerId: string,
  ) {
    return `trip:${tripId}:driver:${driverId}:passenger:${passengerId}:boarding-candidate`;
  }

  async getBoardingCandidate(
    tripId: string,
    driverId: string,
    passengerId: string,
  ): Promise<BoardingCandidateSnapshot | null> {
    try {
      return await this.redisService.get<BoardingCandidateSnapshot>(
        this.getBoardingCandidateKey(tripId, driverId, passengerId),
      );
    } catch (error) {
      this.logger.warn(
        `Unable to restore boarding candidate for trip ${tripId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }

  async saveBoardingCandidate(
    tripId: string,
    driverId: string,
    passengerId: string,
    candidate: BoardingCandidateSnapshot,
  ): Promise<void> {
    try {
      await this.redisService.set(
        this.getBoardingCandidateKey(tripId, driverId, passengerId),
        candidate,
        this.LOCATION_HISTORY_TTL_SECONDS,
      );
    } catch (error) {
      this.logger.warn(
        `Unable to persist boarding candidate for trip ${tripId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
