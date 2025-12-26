import {
  Injectable,
  Logger,
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { AxiosError } from 'axios';
import {
  GeocodeDto,
  ReverseGeocodeDto,
  GeocodeResponse,
  PlacesAutocompleteDto,
  PlaceDetailsDto,
  PlacesSearchDto,
  PlacePrediction,
  PlaceDetails,
  DirectionsDto,
  DirectionsResponse,
  TravelMode,
  Avoid,
} from './dto/google-maps.dto';

@Injectable()
export class GoogleMapsService {
  private readonly logger = new Logger(GoogleMapsService.name);
  private readonly apiKey: string;
  private readonly baseUrl = 'https://maps.googleapis.com/maps/api';

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {
    const apiKey = this.configService.get<string>('GOOGLE_MAPS_API_KEY');
    if (!apiKey) {
      this.logger.warn(
        'GOOGLE_MAPS_API_KEY is not configured. Google Maps services may not work properly.',
      );
    }
    this.apiKey = apiKey || '';
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

      const response = await firstValueFrom(
        this.httpService.get(`${this.baseUrl}/geocode/json`, { params }),
      );

      if (response.data.status === 'ZERO_RESULTS') {
        throw new BadRequestException('No results found for this address');
      }

      if (response.data.status !== 'OK') {
        throw new BadRequestException(
          `Geocoding failed: ${response.data.status}${response.data.error_message ? ` - ${response.data.error_message}` : ''}`,
        );
      }

      const result = response.data.results[0];
      const location = result.geometry.location;

      return {
        formattedAddress: result.formatted_address,
        lat: location.lat,
        lng: location.lng,
        placeId: result.place_id,
        addressComponents: result.address_components?.map((component: any) => ({
          longName: component.long_name,
          shortName: component.short_name,
          types: component.types,
        })),
      };
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      this.logger.error(`Geocoding error: ${error.message}`, error.stack);
      throw new InternalServerErrorException('Failed to geocode address');
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

      const response = await firstValueFrom(
        this.httpService.get(`${this.baseUrl}/geocode/json`, { params }),
      );

      if (response.data.status === 'ZERO_RESULTS') {
        throw new BadRequestException('No results found for these coordinates');
      }

      if (response.data.status !== 'OK') {
        throw new BadRequestException(
          `Reverse geocoding failed: ${response.data.status}${response.data.error_message ? ` - ${response.data.error_message}` : ''}`,
        );
      }

      const result = response.data.results[0];
      const location = result.geometry.location;

      return {
        formattedAddress: result.formatted_address,
        lat: location.lat,
        lng: location.lng,
        placeId: result.place_id,
        addressComponents: result.address_components?.map((component: any) => ({
          longName: component.long_name,
          shortName: component.short_name,
          types: component.types,
        })),
      };
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      this.logger.error(`Reverse geocoding error: ${error.message}`, error.stack);
      throw new InternalServerErrorException('Failed to reverse geocode coordinates');
    }
  }

  /**
   * Get place autocomplete predictions
   */
  async placesAutocomplete(dto: PlacesAutocompleteDto): Promise<PlacePrediction[]> {
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
        this.httpService.get(`${this.baseUrl}/place/autocomplete/json`, { params }),
      );

      if (response.data.status === 'ZERO_RESULTS') {
        return [];
      }

      if (response.data.status !== 'OK' && response.data.status !== 'ZERO_RESULTS') {
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
      this.logger.error(`Places autocomplete error: ${error.message}`, error.stack);
      throw new InternalServerErrorException('Failed to get place autocomplete');
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
        fields: 'place_id,formatted_address,geometry,name,international_phone_number,website,rating,types',
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
      throw new InternalServerErrorException('Failed to get place details');
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
        this.httpService.get(`${this.baseUrl}/place/textsearch/json`, { params }),
      );

      if (response.data.status === 'ZERO_RESULTS') {
        return [];
      }

      if (response.data.status !== 'OK' && response.data.status !== 'ZERO_RESULTS') {
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
      throw new InternalServerErrorException('Failed to search places');
    }
  }

  /**
   * Get directions between origin and destination
   */
  async getDirections(dto: DirectionsDto): Promise<DirectionsResponse> {
    try {
      // Build origin
      const origin = this.buildWaypoint(dto.origin);
      if (!origin) {
        throw new BadRequestException('Origin is required');
      }

      // Build destination
      const destination = this.buildWaypoint(dto.destination);
      if (!destination) {
        throw new BadRequestException('Destination is required');
      }

      const params: Record<string, string> = {
        origin,
        destination,
        key: this.apiKey,
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

      // Add alternatives
      if (dto.alternatives) {
        params.alternatives = 'true';
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

      const response = await firstValueFrom(
        this.httpService.get(`${this.baseUrl}/directions/json`, { params }),
      );

      if (response.data.status === 'ZERO_RESULTS') {
        throw new BadRequestException('No route found between origin and destination');
      }

      if (response.data.status !== 'OK') {
        throw new BadRequestException(
          `Directions failed: ${response.data.status}${response.data.error_message ? ` - ${response.data.error_message}` : ''}`,
        );
      }

      const routes = response.data.routes.map((route: any) => {
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

      return {
        routes,
        status: response.data.status,
      };
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      this.logger.error(`Directions error: ${error.message}`, error.stack);
      throw new InternalServerErrorException('Failed to get directions');
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
}

