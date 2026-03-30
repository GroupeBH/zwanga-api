import { IsString, IsOptional, IsNumber, IsEnum, IsArray, ValidateNested, IsLatitude, IsLongitude, IsBoolean, IsInt, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

// ==================== Geocoding DTOs ====================

export class GeocodeDto {
  @ApiProperty({ description: 'Address to geocode' })
  @IsString()
  address: string;

  @ApiPropertyOptional({ description: 'Region code (e.g., "CD" for Congo)' })
  @IsOptional()
  @IsString()
  region?: string;
}

export class ReverseGeocodeDto {
  @ApiProperty({ description: 'Latitude' })
  @Type(() => Number)
  @IsLatitude()
  lat: number;

  @ApiProperty({ description: 'Longitude' })
  @Type(() => Number)
  @IsLongitude()
  lng: number;
}

export class GeocodeResponse {
  @ApiProperty()
  formattedAddress: string;

  @ApiProperty()
  lat: number;

  @ApiProperty()
  lng: number;

  @ApiPropertyOptional()
  placeId?: string;

  @ApiPropertyOptional()
  addressComponents?: {
    longName: string;
    shortName: string;
    types: string[];
  }[];
}

// ==================== Places DTOs ====================

export class PlacesAutocompleteDto {
  @ApiProperty({ description: 'Input text for autocomplete' })
  @IsString()
  input: string;

  @ApiPropertyOptional({ description: 'Location bias: latitude' })
  @IsOptional()
  @Type(() => Number)
  @IsLatitude()
  locationLat?: number;

  @ApiPropertyOptional({ description: 'Location bias: longitude' })
  @IsOptional()
  @Type(() => Number)
  @IsLongitude()
  locationLng?: number;

  @ApiPropertyOptional({ description: 'Radius in meters for location bias' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  radius?: number;

  @ApiPropertyOptional({ description: 'Region code (e.g., "CD" for Congo)' })
  @IsOptional()
  @IsString()
  region?: string;

  @ApiPropertyOptional({ description: 'Language code (e.g., "fr", "en")' })
  @IsOptional()
  @IsString()
  language?: string;
}

export class PlaceDetailsDto {
  @ApiProperty({ description: 'Place ID from Places API' })
  @IsString()
  placeId: string;

  @ApiPropertyOptional({ description: 'Language code' })
  @IsOptional()
  @IsString()
  language?: string;
}

export class PlacesSearchDto {
  @ApiProperty({ description: 'Search query' })
  @IsString()
  query: string;

  @ApiPropertyOptional({ description: 'Location: latitude' })
  @IsOptional()
  @Type(() => Number)
  @IsLatitude()
  locationLat?: number;

  @ApiPropertyOptional({ description: 'Location: longitude' })
  @IsOptional()
  @Type(() => Number)
  @IsLongitude()
  locationLng?: number;

  @ApiPropertyOptional({ description: 'Radius in meters' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  radius?: number;

  @ApiPropertyOptional({ description: 'Language code' })
  @IsOptional()
  @IsString()
  language?: string;
}

export class PlacePrediction {
  @ApiProperty()
  placeId: string;

  @ApiProperty()
  description: string;

  @ApiPropertyOptional()
  mainText?: string;

  @ApiPropertyOptional()
  secondaryText?: string;
}

export class PlaceDetails {
  @ApiProperty()
  placeId: string;

  @ApiProperty()
  formattedAddress: string;

  @ApiProperty()
  lat: number;

  @ApiProperty()
  lng: number;

  @ApiPropertyOptional()
  name?: string;

  @ApiPropertyOptional()
  phoneNumber?: string;

  @ApiPropertyOptional()
  website?: string;

  @ApiPropertyOptional()
  rating?: number;

  @ApiPropertyOptional()
  types?: string[];
}

export class LandmarkPlacesQueryDto {
  @ApiPropertyOptional({ description: 'City key. For now only kinshasa is supported.', default: 'kinshasa' })
  @IsOptional()
  @IsString()
  city?: string;

  @ApiPropertyOptional({ description: 'Free-text filter on name, commune, category, address or keywords' })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({ description: 'Filter by commune' })
  @IsOptional()
  @IsString()
  commune?: string;

  @ApiPropertyOptional({ description: 'Filter by category' })
  @IsOptional()
  @IsString()
  category?: string;

  @ApiPropertyOptional({ description: 'Maximum number of landmarks to return', default: 12 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number = 12;
}

export class LandmarkPlace {
  @ApiProperty()
  id: string;

  @ApiProperty()
  name: string;

  @ApiProperty()
  query: string;

  @ApiProperty()
  address: string;

  @ApiProperty()
  commune: string;

  @ApiProperty()
  category: string;

  @ApiPropertyOptional()
  description?: string;

  @ApiProperty({ type: [String] })
  keywords: string[];
}

// ==================== Directions DTOs ====================

export enum TravelMode {
  DRIVING = 'driving',
  WALKING = 'walking',
  BICYCLING = 'bicycling',
  TRANSIT = 'transit',
}

export enum Avoid {
  TOLLS = 'tolls',
  HIGHWAYS = 'highways',
  FERRIES = 'ferries',
  INDOOR = 'indoor',
}

export class WaypointDto {
  @ApiPropertyOptional({ description: 'Address or place name' })
  @IsOptional()
  @IsString()
  address?: string;

  @ApiPropertyOptional({ description: 'Latitude' })
  @IsOptional()
  @IsLatitude()
  lat?: number;

  @ApiPropertyOptional({ description: 'Longitude' })
  @IsOptional()
  @IsLongitude()
  lng?: number;

  @ApiPropertyOptional({ description: 'Place ID' })
  @IsOptional()
  @IsString()
  placeId?: string;
}

export class DirectionsDto {
  @ApiProperty({ description: 'Origin waypoint' })
  @ValidateNested()
  @Type(() => WaypointDto)
  origin: WaypointDto;

  @ApiProperty({ description: 'Destination waypoint' })
  @ValidateNested()
  @Type(() => WaypointDto)
  destination: WaypointDto;

  @ApiPropertyOptional({ description: 'Intermediate waypoints', type: [WaypointDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WaypointDto)
  waypoints?: WaypointDto[];

  @ApiPropertyOptional({ enum: TravelMode, default: TravelMode.DRIVING })
  @IsOptional()
  @IsEnum(TravelMode)
  mode?: TravelMode;

  @ApiPropertyOptional({ description: 'Avoid specific features', enum: Avoid, isArray: true })
  @IsOptional()
  @IsArray()
  @IsEnum(Avoid, { each: true })
  avoid?: Avoid[];

  @ApiPropertyOptional({ description: 'Optimize waypoints order' })
  @IsOptional()
  @IsBoolean()
  optimizeWaypoints?: boolean;

  @ApiPropertyOptional({ description: 'Alternatives routes' })
  @IsOptional()
  @IsBoolean()
  alternatives?: boolean;

  @ApiPropertyOptional({ description: 'Language code' })
  @IsOptional()
  @IsString()
  language?: string;

  @ApiPropertyOptional({ description: 'Region code' })
  @IsOptional()
  @IsString()
  region?: string;

  @ApiPropertyOptional({ description: 'Departure time (Unix timestamp)' })
  @IsOptional()
  @IsNumber()
  departureTime?: number;

  @ApiPropertyOptional({ description: 'Arrival time (Unix timestamp)' })
  @IsOptional()
  @IsNumber()
  arrivalTime?: number;
}

export class RouteStep {
  @ApiProperty()
  distance: number; // meters

  @ApiProperty()
  duration: number; // seconds

  @ApiProperty()
  htmlInstructions: string;

  @ApiProperty()
  polyline: string;

  @ApiProperty()
  startLocation: { lat: number; lng: number };

  @ApiProperty()
  endLocation: { lat: number; lng: number };
}

export class RouteLeg {
  @ApiProperty()
  distance: number; // meters

  @ApiProperty()
  duration: number; // seconds

  @ApiProperty()
  startAddress: string;

  @ApiProperty()
  endAddress: string;

  @ApiProperty()
  startLocation: { lat: number; lng: number };

  @ApiProperty()
  endLocation: { lat: number; lng: number };

  @ApiProperty({ type: [RouteStep] })
  steps: RouteStep[];
}

export class Route {
  @ApiProperty()
  summary: string;

  @ApiProperty({ type: [RouteLeg] })
  legs: RouteLeg[];

  @ApiProperty()
  overviewPolyline: string;

  @ApiProperty()
  bounds: {
    northeast: { lat: number; lng: number };
    southwest: { lat: number; lng: number };
  };

  @ApiProperty()
  copyrights: string;

  @ApiProperty()
  warnings: string[];
}

export class DirectionsResponse {
  @ApiProperty({ type: [Route] })
  routes: Route[];

  @ApiProperty()
  status: string;

  @ApiPropertyOptional()
  errorMessage?: string;
}

