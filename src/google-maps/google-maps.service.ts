import {
  Injectable,
  Logger,
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import * as crypto from 'crypto';
import { CacheService } from '../common/services/cache.service';
import { AxiosError } from 'axios';
import {
  GeocodeDto,
  ReverseGeocodeDto,
  GeocodeResponse,
  GeocodeAddressComponent,
  PlacesAutocompleteDto,
  PlaceDetailsDto,
  PlacesSearchDto,
  LandmarkPlace,
  LandmarkPlacesQueryDto,
  PlacePrediction,
  PlaceDetails,
  DirectionsDto,
  DirectionsResponse,
  TravelMode,
  Avoid,
} from './dto/google-maps.dto';
import { KINSHASA_LANDMARKS } from './data/kinshasa-landmarks';

type GeocodePrecisionLevel = 'EXACT' | 'HIGH' | 'MEDIUM' | 'LOW';

@Injectable()
export class GoogleMapsService {
  private readonly logger = new Logger(GoogleMapsService.name);
  private readonly apiKey: string;
  private readonly baseUrl = 'https://maps.googleapis.com/maps/api';

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
    private readonly cacheService: CacheService,
  ) {
    const apiKey = this.configService.get<string>('GOOGLE_MAPS_API_KEY');
    if (!apiKey) {
      this.logger.warn(
        'GOOGLE_MAPS_API_KEY is not configured. Google Maps services may not work properly.',
      );
    }
    this.apiKey = apiKey || '';
  }

  private selectBestGeocodeResult(results: any[]): any {
    const isPrecise = (result: any) =>
      ['ROOFTOP', 'RANGE_INTERPOLATED'].includes(
        result.geometry?.location_type,
      );

    return (
      results.find((result) => !result.partial_match && isPrecise(result)) ||
      results.find((result) => !result.partial_match) ||
      results.find((result) => isPrecise(result)) ||
      results[0]
    );
  }

  private mapAddressComponents(
    components: any[] = [],
  ): GeocodeAddressComponent[] {
    return components.map((component: any) => ({
      longName: component.long_name,
      shortName: component.short_name,
      types: component.types,
    }));
  }

  private findAddressComponent(
    components: GeocodeAddressComponent[] | undefined,
    ...types: string[]
  ): GeocodeAddressComponent | undefined {
    return components?.find((component) =>
      types.some((type) => component.types.includes(type)),
    );
  }

  private getComponentLongName(
    components: GeocodeAddressComponent[] | undefined,
    ...types: string[]
  ): string | undefined {
    return this.findAddressComponent(components, ...types)?.longName;
  }

  private getComponentShortName(
    components: GeocodeAddressComponent[] | undefined,
    ...types: string[]
  ): string | undefined {
    return this.findAddressComponent(components, ...types)?.shortName;
  }

  private mapStructuredAddress(
    components: GeocodeAddressComponent[] | undefined,
  ): GeocodeResponse['addressDetails'] {
    const streetNumber = this.getComponentLongName(components, 'street_number');
    const street = this.getComponentLongName(components, 'route');
    const fullStreet =
      [streetNumber, street].filter(Boolean).join(' ') || undefined;

    return {
      streetNumber,
      street,
      fullStreet,
      neighborhood: this.getComponentLongName(components, 'neighborhood'),
      sublocality: this.getComponentLongName(components, 'sublocality'),
      commune:
        this.getComponentLongName(components, 'sublocality_level_1') ??
        this.getComponentLongName(components, 'sublocality') ??
        this.getComponentLongName(components, 'administrative_area_level_3'),
      city:
        this.getComponentLongName(components, 'locality') ??
        this.getComponentLongName(components, 'postal_town'),
      district: this.getComponentLongName(
        components,
        'administrative_area_level_2',
      ),
      province: this.getComponentLongName(
        components,
        'administrative_area_level_1',
      ),
      country: this.getComponentLongName(components, 'country'),
      countryCode: this.getComponentShortName(components, 'country'),
      postalCode: this.getComponentLongName(components, 'postal_code'),
      premise: this.getComponentLongName(components, 'premise'),
      subpremise: this.getComponentLongName(components, 'subpremise'),
    };
  }

  private mapGeocodeBounds(bounds: any): GeocodeResponse['bounds'] {
    if (!bounds?.northeast || !bounds?.southwest) {
      return undefined;
    }

    return {
      northeast: {
        lat: bounds.northeast.lat,
        lng: bounds.northeast.lng,
      },
      southwest: {
        lat: bounds.southwest.lat,
        lng: bounds.southwest.lng,
      },
    };
  }

  private mapPlusCode(plusCode: any): GeocodeResponse['plusCode'] {
    if (!plusCode) {
      return undefined;
    }

    return {
      globalCode: plusCode.global_code,
      compoundCode: plusCode.compound_code,
    };
  }

  private hasAnyType(
    resultTypes: string[] | undefined,
    expectedTypes: string[],
  ): boolean {
    return expectedTypes.some((type) => resultTypes?.includes(type));
  }

  private getGeocodePrecision(result: any): GeocodeResponse['precision'] {
    const locationType = result.geometry?.location_type;
    const resultTypes = result.types ?? [];
    const partialMatch = result.partial_match ?? false;
    const isStreetLevel = this.hasAnyType(resultTypes, [
      'street_address',
      'route',
      'intersection',
      'premise',
      'subpremise',
    ]);
    const isExactAddress =
      !partialMatch &&
      locationType === 'ROOFTOP' &&
      this.hasAnyType(resultTypes, ['street_address', 'premise', 'subpremise']);

    let level: GeocodePrecisionLevel = 'LOW';
    if (isExactAddress) {
      level = 'EXACT';
    } else if (
      !partialMatch &&
      ['ROOFTOP', 'RANGE_INTERPOLATED'].includes(locationType)
    ) {
      level = 'HIGH';
    } else if (
      !partialMatch &&
      (locationType === 'GEOMETRIC_CENTER' ||
        isStreetLevel ||
        this.hasAnyType(resultTypes, [
          'point_of_interest',
          'establishment',
          'plus_code',
        ]))
    ) {
      level = 'MEDIUM';
    }

    return {
      level,
      isExactAddress,
      isStreetLevel,
      isApproximate: partialMatch || locationType === 'APPROXIMATE',
    };
  }

  private mapGeocodeResult(result: any): GeocodeResponse {
    const location = result.geometry.location;
    const addressComponents = this.mapAddressComponents(
      result.address_components,
    );

    return {
      formattedAddress: result.formatted_address,
      lat: location.lat,
      lng: location.lng,
      placeId: result.place_id,
      locationType: result.geometry?.location_type,
      partialMatch: result.partial_match ?? false,
      resultTypes: result.types ?? [],
      addressComponents,
      addressDetails: this.mapStructuredAddress(addressComponents),
      viewport: this.mapGeocodeBounds(result.geometry?.viewport),
      bounds: this.mapGeocodeBounds(result.geometry?.bounds),
      plusCode: this.mapPlusCode(result.plus_code),
      precision: this.getGeocodePrecision(result),
    };
  }

  /**
   * Geocode an address to coordinates
   */
  async geocode(dto: GeocodeDto): Promise<GeocodeResponse> {
    try {
      const params: Record<string, string> = {
        address: dto.address,
        key: this.apiKey,
      };

      if (dto.region) {
        params.region = dto.region;
      }

      if (dto.language) {
        params.language = dto.language;
      }

      if (dto.components) {
        params.components = dto.components;
      }

      const response = await firstValueFrom(
        this.httpService.get(`${this.baseUrl}/geocode/json`, { params }),
      );

      if (response.data.status === 'ZERO_RESULTS') {
        throw new BadRequestException(
          'Aucun résultat trouvé pour cette adresse',
        );
      }

      if (response.data.status !== 'OK') {
        throw new BadRequestException(
          `Échec du géocodage : ${response.data.status}${response.data.error_message ? ` - ${response.data.error_message}` : ''}`,
        );
      }

      return this.mapGeocodeResult(
        this.selectBestGeocodeResult(response.data.results),
      );
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      this.logger.error(`Geocoding error: ${error.message}`, error.stack);
      throw new InternalServerErrorException("Échec du géocodage de l'adresse");
    }
  }

  /**
   * Reverse geocode coordinates to address
   */
  async reverseGeocode(dto: ReverseGeocodeDto): Promise<GeocodeResponse> {
    try {
      const params: Record<string, string> = {
        latlng: `${dto.lat},${dto.lng}`,
        key: this.apiKey,
      };

      if (dto.language) {
        params.language = dto.language;
      }

      if (dto.region) {
        params.region = dto.region;
      }

      if (dto.resultType) {
        params.result_type = dto.resultType;
      }

      if (dto.locationType) {
        params.location_type = dto.locationType;
      }

      const response = await firstValueFrom(
        this.httpService.get(`${this.baseUrl}/geocode/json`, { params }),
      );

      if (response.data.status === 'ZERO_RESULTS') {
        throw new BadRequestException(
          'Aucun résultat trouvé pour ces coordonnées',
        );
      }

      if (response.data.status !== 'OK') {
        throw new BadRequestException(
          `Reverse geocoding failed: ${response.data.status}${response.data.error_message ? ` - ${response.data.error_message}` : ''}`,
        );
      }

      return this.mapGeocodeResult(
        this.selectBestGeocodeResult(response.data.results),
      );
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      this.logger.error(
        `Reverse geocoding error: ${error.message}`,
        error.stack,
      );
      throw new InternalServerErrorException(
        'Échec du géocodage inverse des coordonnées',
      );
    }
  }

  /**
   * Get place autocomplete predictions
   */
  async placesAutocomplete(
    dto: PlacesAutocompleteDto,
  ): Promise<PlacePrediction[]> {
    try {
      const params: Record<string, string> = {
        input: dto.input,
        key: this.apiKey,
      };

      if (dto.locationLat && dto.locationLng) {
        params.location = `${dto.locationLat},${dto.locationLng}`;
        if (dto.radius) {
          params.radius = dto.radius.toString();
        }
      }

      if (dto.region) {
        params.region = dto.region;
      }

      if (dto.language) {
        params.language = dto.language;
      }

      const response = await firstValueFrom(
        this.httpService.get(`${this.baseUrl}/place/autocomplete/json`, {
          params,
        }),
      );

      if (response.data.status === 'ZERO_RESULTS') {
        return [];
      }

      if (
        response.data.status !== 'OK' &&
        response.data.status !== 'ZERO_RESULTS'
      ) {
        throw new BadRequestException(
          `Places autocomplete failed: ${response.data.status}${response.data.error_message ? ` - ${response.data.error_message}` : ''}`,
        );
      }

      return response.data.predictions.map((prediction: any) => ({
        placeId: prediction.place_id,
        description: prediction.description,
        mainText: prediction.structured_formatting?.main_text,
        secondaryText: prediction.structured_formatting?.secondary_text,
      }));
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      this.logger.error(
        `Places autocomplete error: ${error.message}`,
        error.stack,
      );
      throw new InternalServerErrorException(
        "Échec de la récupération de l'autocomplétion des lieux",
      );
    }
  }

  /**
   * Get place details by place ID
   */
  async getPlaceDetails(dto: PlaceDetailsDto): Promise<PlaceDetails> {
    try {
      const params: Record<string, string> = {
        place_id: dto.placeId,
        key: this.apiKey,
        fields:
          'place_id,formatted_address,geometry,name,international_phone_number,website,rating,types',
      };

      if (dto.language) {
        params.language = dto.language;
      }

      const response = await firstValueFrom(
        this.httpService.get(`${this.baseUrl}/place/details/json`, { params }),
      );

      if (response.data.status !== 'OK') {
        throw new BadRequestException(
          `Place details failed: ${response.data.status}${response.data.error_message ? ` - ${response.data.error_message}` : ''}`,
        );
      }

      const result = response.data.result;
      const location = result.geometry.location;

      return {
        placeId: result.place_id,
        formattedAddress: result.formatted_address,
        lat: location.lat,
        lng: location.lng,
        name: result.name,
        phoneNumber: result.international_phone_number,
        website: result.website,
        rating: result.rating,
        types: result.types,
      };
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      this.logger.error(`Place details error: ${error.message}`, error.stack);
      throw new InternalServerErrorException(
        'Échec de la récupération des détails du lieu',
      );
    }
  }

  /**
   * Search for places using text query
   */
  async placesSearch(dto: PlacesSearchDto): Promise<PlaceDetails[]> {
    try {
      const params: Record<string, string> = {
        query: dto.query,
        key: this.apiKey,
      };

      if (dto.locationLat && dto.locationLng) {
        params.location = `${dto.locationLat},${dto.locationLng}`;
        if (dto.radius) {
          params.radius = dto.radius.toString();
        }
      }

      if (dto.language) {
        params.language = dto.language;
      }

      const response = await firstValueFrom(
        this.httpService.get(`${this.baseUrl}/place/textsearch/json`, {
          params,
        }),
      );

      if (response.data.status === 'ZERO_RESULTS') {
        return [];
      }

      if (
        response.data.status !== 'OK' &&
        response.data.status !== 'ZERO_RESULTS'
      ) {
        throw new BadRequestException(
          `Places search failed: ${response.data.status}${response.data.error_message ? ` - ${response.data.error_message}` : ''}`,
        );
      }

      return response.data.results.map((result: any) => {
        const location = result.geometry.location;
        return {
          placeId: result.place_id,
          formattedAddress: result.formatted_address,
          lat: location.lat,
          lng: location.lng,
          name: result.name,
          rating: result.rating,
          types: result.types,
        };
      });
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      this.logger.error(`Places search error: ${error.message}`, error.stack);
      throw new InternalServerErrorException('Échec de la recherche de lieux');
    }
  }

  async getLandmarks(dto: LandmarkPlacesQueryDto): Promise<LandmarkPlace[]> {
    const city = dto.city?.trim().toLowerCase() || 'kinshasa';

    if (city !== 'kinshasa') {
      return [];
    }

    const normalizedSearch = dto.search?.trim().toLowerCase() || '';
    const normalizedCommune = dto.commune?.trim().toLowerCase() || '';
    const normalizedCategory = dto.category?.trim().toLowerCase() || '';
    const limit = Math.min(Math.max(dto.limit ?? 12, 1), 30);

    return KINSHASA_LANDMARKS.filter((landmark) => {
      const matchesSearch =
        !normalizedSearch ||
        [
          landmark.name,
          landmark.query,
          landmark.address,
          landmark.commune,
          landmark.category,
          landmark.description,
          ...landmark.keywords,
        ]
          .filter(
            (value): value is string =>
              typeof value === 'string' && value.length > 0,
          )
          .some((value) => value.toLowerCase().includes(normalizedSearch));

      const matchesCommune =
        !normalizedCommune ||
        landmark.commune.toLowerCase().includes(normalizedCommune);

      const matchesCategory =
        !normalizedCategory ||
        landmark.category.toLowerCase().includes(normalizedCategory);

      return matchesSearch && matchesCommune && matchesCategory;
    }).slice(0, limit);
  }

  /**
   * Get directions between origin and destination
   */
  async getDirections(dto: DirectionsDto): Promise<DirectionsResponse> {
    // console.log('getDirections', dto);
    const singleRouteDto: DirectionsDto = { ...dto, alternatives: false };
    const cacheKey = this.getDirectionsCacheKey(singleRouteDto);

    try {
      // Try to get from cache first
      const cached = await this.cacheService.get<DirectionsResponse>(cacheKey);
      if (cached) {
        // this.logger.debug('Returning directions from cache');
        return {
          ...cached,
          routes: (cached.routes ?? []).slice(0, 1),
        };
      }

      // Build origin
      const origin = this.buildWaypoint(dto.origin);
      if (!origin) {
        throw new BadRequestException('Le point de départ est requis');
      }

      // Build destination
      const destination = this.buildWaypoint(dto.destination);
      if (!destination) {
        throw new BadRequestException('La destination est requise');
      }

      const params: Record<string, string> = {
        origin,
        destination,
        key: this.apiKey,
        alternatives: 'false',
      };

      // Add waypoints if provided
      if (dto.waypoints && dto.waypoints.length > 0) {
        const waypointsStr = dto.waypoints
          .map((wp) => this.buildWaypoint(wp))
          .filter((wp) => wp !== null)
          .join('|');

        if (waypointsStr) {
          params.waypoints = dto.optimizeWaypoints
            ? `optimize:true|${waypointsStr}`
            : waypointsStr;
        }
      }

      // Add travel mode
      params.mode = dto.mode || TravelMode.DRIVING;

      // Add avoid options
      if (dto.avoid && dto.avoid.length > 0) {
        params.avoid = dto.avoid.join('|');
      }

      // Add language and region
      if (dto.language) {
        params.language = dto.language;
      }

      if (dto.region) {
        params.region = dto.region;
      }

      // Add departure/arrival time
      if (dto.departureTime) {
        params.departure_time = dto.departureTime.toString();
      }

      if (dto.arrivalTime) {
        params.arrival_time = dto.arrivalTime.toString();
      }
      // console.log('params', params);
      const response = await firstValueFrom(
        this.httpService.get(`${this.baseUrl}/directions/json`, { params }),
      );

      if (response.data.status === 'ZERO_RESULTS') {
        throw new BadRequestException(
          'Aucun itinéraire trouvé entre le départ et la destination',
        );
      }

      if (response.data.status !== 'OK') {
        throw new BadRequestException(
          `Directions failed: ${response.data.status}${response.data.error_message ? ` - ${response.data.error_message}` : ''}`,
        );
      }

      const providerRoutes = Array.isArray(response.data.routes)
        ? response.data.routes.slice(0, 1)
        : [];

      if (providerRoutes.length === 0) {
        throw new BadRequestException(
          'Aucun itineraire trouve entre le depart et la destination',
        );
      }

      const routes = providerRoutes.map((route: any) => {
        const legs = route.legs.map((leg: any) => ({
          distance: leg.distance.value,
          duration: leg.duration.value,
          startAddress: leg.start_address,
          endAddress: leg.end_address,
          startLocation: {
            lat: leg.start_location.lat,
            lng: leg.start_location.lng,
          },
          endLocation: {
            lat: leg.end_location.lat,
            lng: leg.end_location.lng,
          },
          steps: leg.steps.map((step: any) => ({
            distance: step.distance.value,
            duration: step.duration.value,
            htmlInstructions: step.html_instructions,
            polyline: step.polyline.points,
            startLocation: {
              lat: step.start_location.lat,
              lng: step.start_location.lng,
            },
            endLocation: {
              lat: step.end_location.lat,
              lng: step.end_location.lng,
            },
          })),
        }));

        return {
          summary: route.summary,
          legs,
          overviewPolyline: route.overview_polyline.points,
          bounds: {
            northeast: {
              lat: route.bounds.northeast.lat,
              lng: route.bounds.northeast.lng,
            },
            southwest: {
              lat: route.bounds.southwest.lat,
              lng: route.bounds.southwest.lng,
            },
          },
          copyrights: route.copyrights,
          warnings: route.warnings || [],
        };
      });

      const result = {
        routes,
        status: response.data.status,
      };

      // Cache the result for one week (604800 seconds)
      await this.cacheService.set(cacheKey, result, 604800);

      return result;
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      // this.logger.error(`Directions error: ${error.message}`, error.stack);
      throw new InternalServerErrorException(
        'Échec de la récupération des directions',
      );
    }
  }

  /**
   * Build waypoint string from WaypointDto
   */
  private buildWaypoint(waypoint: {
    address?: string;
    lat?: number;
    lng?: number;
    placeId?: string;
  }): string | null {
    if (waypoint.placeId) {
      return `place_id:${waypoint.placeId}`;
    }
    if (waypoint.lat !== undefined && waypoint.lng !== undefined) {
      return `${waypoint.lat},${waypoint.lng}`;
    }
    if (waypoint.address) {
      return waypoint.address;
    }
    return null;
  }

  /**
   * Generate a unique cache key for directions based on the DTO
   */
  private getDirectionsCacheKey(dto: DirectionsDto): string {
    const data = JSON.stringify({
      origin: dto.origin,
      destination: dto.destination,
      waypoints: dto.waypoints,
      optimizeWaypoints: dto.optimizeWaypoints,
      mode: dto.mode,
      avoid: dto.avoid,
      alternatives: false,
      language: dto.language,
      region: dto.region,
      departureTime: dto.departureTime,
      arrivalTime: dto.arrivalTime,
    });

    const hash = crypto.createHash('md5').update(data).digest('hex');
    return `google_maps:directions:${hash}`;
  }
}
