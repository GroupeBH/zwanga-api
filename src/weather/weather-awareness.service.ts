import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import { firstValueFrom } from 'rxjs';
import { CacheService } from '../common/services/cache.service';
import { DEFAULT_WEATHER_ZONES } from './data/default-weather-zones';
import {
  WeatherCoordinates,
  WeatherObservation,
  WeatherRouteImpact,
  WeatherZone,
} from './weather.types';

interface OpenWeatherCondition {
  id?: number;
  description?: string;
}

interface OpenWeatherCurrentResponse {
  weather?: OpenWeatherCondition[];
  rain?: {
    '1h'?: number;
  };
  dt?: number;
}

const WEATHER_REFRESH_INTERVAL_MS = 20 * 60 * 1000;
const WEATHER_PRICE_MULTIPLIER = 1.3;
const WEATHER_ETA_MULTIPLIER = 1.4;
const DEFAULT_HEAVY_RAIN_THRESHOLD_MM_PER_HOUR = 7.6;
const HEAVY_RAIN_CONDITION_CODES = new Set([202, 502, 503, 504, 522]);

@Injectable()
export class WeatherAwarenessService implements OnModuleInit {
  private readonly logger = new Logger(WeatherAwarenessService.name);
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly zones: WeatherZone[];
  private readonly heavyRainThresholdMmPerHour: number;
  private refreshInProgress: Promise<void> | null = null;

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
    private readonly cacheService: CacheService,
  ) {
    this.apiKey =
      this.configService.get<string>('OPENWEATHER_API_KEY')?.trim() ?? '';
    this.baseUrl = (
      this.configService.get<string>('OPENWEATHER_BASE_URL') ??
      'https://api.openweathermap.org/data/2.5'
    ).replace(/\/$/, '');
    this.zones = this.loadConfiguredZones();
    this.heavyRainThresholdMmPerHour = this.readPositiveNumber(
      this.configService.get<string>(
        'WEATHER_HEAVY_RAIN_THRESHOLD_MM_PER_HOUR',
      ),
      DEFAULT_HEAVY_RAIN_THRESHOLD_MM_PER_HOUR,
    );

    if (!this.apiKey) {
      this.logger.warn(
        'OPENWEATHER_API_KEY is not configured. Weather impacts will remain neutral.',
      );
    }
  }

  onModuleInit(): void {
    void this.refreshWeatherCache();
  }

  @Interval(WEATHER_REFRESH_INTERVAL_MS)
  async refreshWeatherCache(): Promise<void> {
    if (this.refreshInProgress) {
      return this.refreshInProgress;
    }

    this.refreshInProgress = this.refreshZones().finally(() => {
      this.refreshInProgress = null;
    });

    return this.refreshInProgress;
  }

  async getRouteImpact(
    departureCoordinates?: WeatherCoordinates | null,
    arrivalCoordinates?: WeatherCoordinates | null,
  ): Promise<WeatherRouteImpact> {
    try {
      const matchedZones = this.findRouteZones(
        departureCoordinates,
        arrivalCoordinates,
      );

      if (matchedZones.length === 0) {
        return this.buildNeutralImpact();
      }

      const observations = await Promise.all(
        matchedZones.map((zone) =>
          this.cacheService.get<WeatherObservation>(this.getCacheKey(zone.id)),
        ),
      );
      const availableObservations = observations.filter(
        (observation): observation is WeatherObservation =>
          observation?.available === true,
      );
      const affectedZoneIds = availableObservations
        .filter((observation) => observation.heavyRain)
        .map((observation) => observation.zoneId);
      const heavyRain = affectedZoneIds.length > 0;

      if (observations.some((observation) => !observation)) {
        void this.refreshWeatherCache();
      }

      return {
        heavyRain,
        dataAvailable: availableObservations.length > 0,
        priceMultiplier: heavyRain ? WEATHER_PRICE_MULTIPLIER : 1,
        etaMultiplier: heavyRain ? WEATHER_ETA_MULTIPLIER : 1,
        evaluatedZoneIds: matchedZones.map((zone) => zone.id),
        affectedZoneIds,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Unable to read weather impact: ${message}`);
      return this.buildNeutralImpact();
    }
  }

  private async refreshZones(): Promise<void> {
    const observations = await Promise.all(
      this.zones.map((zone) => this.fetchZoneObservation(zone)),
    );

    await Promise.all(
      observations.map(async (observation) => {
        try {
          await this.cacheService.set(
            this.getCacheKey(observation.zoneId),
            observation,
            WEATHER_REFRESH_INTERVAL_MS,
          );
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          this.logger.warn(
            `Unable to cache weather for zone ${observation.zoneId}: ${message}`,
          );
        }
      }),
    );
  }

  private async fetchZoneObservation(
    zone: WeatherZone,
  ): Promise<WeatherObservation> {
    if (!this.apiKey) {
      return this.buildUnavailableObservation(zone.id);
    }

    const [longitude, latitude] = zone.coordinates;

    try {
      const response = await firstValueFrom(
        this.httpService.get<OpenWeatherCurrentResponse>(
          `${this.baseUrl}/weather`,
          {
            params: {
              lat: latitude,
              lon: longitude,
              appid: this.apiKey,
              units: 'metric',
            },
          },
        ),
      );
      const conditions = Array.isArray(response.data.weather)
        ? response.data.weather
        : [];
      const conditionCodes = conditions
        .map((condition) => Number(condition.id))
        .filter((conditionCode) => Number.isFinite(conditionCode));
      const rainOneHourMm = Number(response.data.rain?.['1h']) || 0;
      const heavyRain =
        conditionCodes.some((conditionCode) =>
          HEAVY_RAIN_CONDITION_CODES.has(conditionCode),
        ) || rainOneHourMm >= this.heavyRainThresholdMmPerHour;

      return {
        zoneId: zone.id,
        available: true,
        heavyRain,
        conditionCodes,
        description: conditions[0]?.description ?? null,
        rainOneHourMm,
        observedAt: this.toObservationDate(response.data.dt),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Weather API failed for ${zone.name} (${zone.id}): ${message}`,
      );
      return this.buildUnavailableObservation(zone.id);
    }
  }

  private findRouteZones(
    departureCoordinates?: WeatherCoordinates | null,
    arrivalCoordinates?: WeatherCoordinates | null,
  ): WeatherZone[] {
    const matchedZones = new Map<string, WeatherZone>();
    const routeCoordinates = [departureCoordinates, arrivalCoordinates];

    if (
      this.isValidCoordinates(departureCoordinates) &&
      this.isValidCoordinates(arrivalCoordinates)
    ) {
      routeCoordinates.splice(1, 0, [
        (departureCoordinates[0] + arrivalCoordinates[0]) / 2,
        (departureCoordinates[1] + arrivalCoordinates[1]) / 2,
      ]);
    }

    for (const coordinates of routeCoordinates) {
      if (!this.isValidCoordinates(coordinates)) {
        continue;
      }

      const nearestZone = this.findNearestZone(coordinates);
      if (nearestZone) {
        matchedZones.set(nearestZone.id, nearestZone);
      }
    }

    return Array.from(matchedZones.values());
  }

  private findNearestZone(coordinates: WeatherCoordinates): WeatherZone | null {
    let nearestZone: WeatherZone | null = null;
    let nearestDistanceKm = Number.POSITIVE_INFINITY;

    for (const zone of this.zones) {
      const distanceKm = this.calculateDistanceKm(
        coordinates,
        zone.coordinates,
      );
      if (
        distanceKm <= zone.coverageRadiusKm &&
        distanceKm < nearestDistanceKm
      ) {
        nearestZone = zone;
        nearestDistanceKm = distanceKm;
      }
    }

    return nearestZone;
  }

  private calculateDistanceKm(
    origin: WeatherCoordinates,
    destination: WeatherCoordinates,
  ): number {
    const toRadians = (value: number) => (value * Math.PI) / 180;
    const [originLongitude, originLatitude] = origin;
    const [destinationLongitude, destinationLatitude] = destination;
    const latitudeDelta = toRadians(destinationLatitude - originLatitude);
    const longitudeDelta = toRadians(destinationLongitude - originLongitude);
    const originLatitudeRadians = toRadians(originLatitude);
    const destinationLatitudeRadians = toRadians(destinationLatitude);
    const haversine =
      Math.sin(latitudeDelta / 2) ** 2 +
      Math.cos(originLatitudeRadians) *
        Math.cos(destinationLatitudeRadians) *
        Math.sin(longitudeDelta / 2) ** 2;

    return (
      6371 * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine))
    );
  }

  private loadConfiguredZones(): WeatherZone[] {
    const configuredZones = this.configService
      .get<string>('WEATHER_ZONES_JSON')
      ?.trim();

    if (!configuredZones) {
      return DEFAULT_WEATHER_ZONES;
    }

    try {
      const parsedZones: unknown = JSON.parse(configuredZones);
      if (!Array.isArray(parsedZones)) {
        throw new Error('WEATHER_ZONES_JSON must be an array');
      }

      const validZones = parsedZones.filter((zone): zone is WeatherZone =>
        this.isValidZone(zone),
      );
      if (validZones.length !== parsedZones.length || validZones.length === 0) {
        throw new Error('one or more weather zones are invalid');
      }

      return validZones;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Invalid WEATHER_ZONES_JSON (${message}). Using Kinshasa defaults.`,
      );
      return DEFAULT_WEATHER_ZONES;
    }
  }

  private isValidZone(value: unknown): value is WeatherZone {
    if (!value || typeof value !== 'object') {
      return false;
    }

    const zone = value as Partial<WeatherZone>;
    return (
      typeof zone.id === 'string' &&
      zone.id.trim().length > 0 &&
      typeof zone.name === 'string' &&
      typeof zone.city === 'string' &&
      typeof zone.province === 'string' &&
      typeof zone.countryCode === 'string' &&
      this.isValidCoordinates(zone.coordinates) &&
      typeof zone.coverageRadiusKm === 'number' &&
      Number.isFinite(zone.coverageRadiusKm) &&
      zone.coverageRadiusKm > 0
    );
  }

  private isValidCoordinates(
    coordinates?: WeatherCoordinates | null,
  ): coordinates is WeatherCoordinates {
    return (
      Array.isArray(coordinates) &&
      coordinates.length === 2 &&
      Number.isFinite(coordinates[0]) &&
      Number.isFinite(coordinates[1]) &&
      coordinates[0] >= -180 &&
      coordinates[0] <= 180 &&
      coordinates[1] >= -90 &&
      coordinates[1] <= 90
    );
  }

  private readPositiveNumber(
    value: string | undefined,
    fallback: number,
  ): number {
    const parsedValue = Number(value);
    return Number.isFinite(parsedValue) && parsedValue > 0
      ? parsedValue
      : fallback;
  }

  private toObservationDate(timestamp?: number): string {
    if (typeof timestamp === 'number' && Number.isFinite(timestamp)) {
      return new Date(timestamp * 1000).toISOString();
    }

    return new Date().toISOString();
  }

  private buildUnavailableObservation(zoneId: string): WeatherObservation {
    return {
      zoneId,
      available: false,
      heavyRain: false,
      conditionCodes: [],
      description: null,
      rainOneHourMm: 0,
      observedAt: new Date().toISOString(),
    };
  }

  private buildNeutralImpact(): WeatherRouteImpact {
    return {
      heavyRain: false,
      dataAvailable: false,
      priceMultiplier: 1,
      etaMultiplier: 1,
      evaluatedZoneIds: [],
      affectedZoneIds: [],
    };
  }

  private getCacheKey(zoneId: string): string {
    return `weather:current:${zoneId}`;
  }
}
