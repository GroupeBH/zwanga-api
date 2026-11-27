import { Injectable, Logger } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { LocationHistorySampleDto } from '../dto/location-history-sample.dto';
import { RedisService } from './redis.service';
import { normalizeLatLngCoordinate } from '../utils/tracking-coordinates';
import type { BoardingCandidateSnapshot } from '../../bookings/boarding-detection';
import { appendLocationHistory } from './location-history-store';

export interface LocationObservationMetadata {
  samples?: LocationHistorySampleDto[];
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

export class LocationHistoryPendingError extends Error {
  constructor() { super('Committed GPS history is not ready for automatic progression'); }
}

@Injectable()
export class LocationHistoryService {
  // Shared only within one evaluation, never a cross-request authorization cache.
  private readonly evaluationSnapshot = new AsyncLocalStorage<Map<string, unknown>>();
  private readonly logger = new Logger(LocationHistoryService.name);
  private readonly LOCATION_HISTORY_TTL_SECONDS = 6 * 60 * 60;

  constructor(private readonly redisService: RedisService) {}

  async withRideSnapshot<T>(tripId: string, participants: Array<{
    bookingId: string; passengerId: string; driverId: string;
    driverRecordedAt: Date | null; passengerRecordedAt: Date | null;
  }>, work: () => Promise<T>): Promise<T> {
    const keys = [...new Set([this.getDriverKey(tripId), ...participants.flatMap(p => [
      this.getPassengerKey(p.bookingId), this.getBoardingCandidateKey(tripId, p.driverId, p.passengerId),
    ])])];
    const values = await this.redisService.getMany<unknown>(keys);
    const snapshot = new Map(keys.map((key, i) => [key, values[i]]));
    const requireRecorded = (key: string, at: Date | null) => {
      if (!at) return;
      const history = snapshot.get(key) as LocationHistorySnapshot | null;
      if (!(Date.parse(history?.current?.recordedAt ?? '') >= at.getTime()))
        throw new LocationHistoryPendingError();
    };
    // The SQL queue can now commit before Redis history. Do not make a pickup,
    // no-show or dropoff decision from a cache snapshot older than that SQL GPS.
    for (const p of participants) {
      requireRecorded(this.getDriverKey(tripId), p.driverRecordedAt);
      requireRecorded(this.getPassengerKey(p.bookingId), p.passengerRecordedAt);
    }
    return this.evaluationSnapshot.run(snapshot, work);
  }

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
      const native: TrackedLocationPoint[] = [];
      const now = Date.now();
      for (const sample of metadata.samples?.slice(-10) ?? []) {
        const at = Date.parse(sample.recordedAt);
        if (!Number.isFinite(at) || at > now || now - at > 90_000 ||
          at > recordedAt.getTime() || !Number.isFinite(sample.accuracy) ||
          sample.accuracy < 0 || sample.accuracy > 70) continue;
        const point = this.normalizePoint(sample.latitude, sample.longitude, new Date(at),
          { accuracyMeters: sample.accuracy });
        if (point) native.push(point);
      }
      await appendLocationHistory(
        this.redisService.getClient(), key, current, native,
        Boolean(metadata.samples?.length), this.LOCATION_HISTORY_TTL_SECONDS,
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
      const snapshot = this.evaluationSnapshot.getStore();
      if (snapshot?.has(key)) return snapshot.get(key) as LocationHistorySnapshot | null;
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
      const key = this.getBoardingCandidateKey(tripId, driverId, passengerId);
      const snapshot = this.evaluationSnapshot.getStore();
      if (snapshot?.has(key)) return snapshot.get(key) as BoardingCandidateSnapshot | null;
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
      const key = this.getBoardingCandidateKey(tripId, driverId, passengerId);
      if (this.evaluationSnapshot.getStore()?.has(key)) this.evaluationSnapshot.getStore()!.set(key, candidate);
    } catch (error) {
      this.logger.warn(
        `Unable to persist boarding candidate for trip ${tripId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
