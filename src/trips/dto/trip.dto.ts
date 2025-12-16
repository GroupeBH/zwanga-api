import {
  IsString,
  IsNotEmpty,
  IsNumber,
  IsDateString,
  IsOptional,
  IsEnum,
  IsBoolean,
  Min,
  Max,
  IsArray,
  ArrayMinSize,
  ArrayMaxSize,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { TripStatus } from '../entities/trip.entity';

export class CreateTripDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  departureLocation: string;

  @ApiProperty({
    description: 'Coordonnées du point de départ [longitude, latitude]',
    example: [15.2663, -4.325],
    minItems: 2,
    maxItems: 2,
  })
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(2)
  @IsNumber({}, { each: true })
  departureCoordinates: [number, number];

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  arrivalLocation: string;

  @ApiProperty({
    description: 'Coordonnées du point d’arrivée [longitude, latitude]',
    example: [15.3222, -4.4419],
    minItems: 2,
    maxItems: 2,
  })
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(2)
  @IsNumber({}, { each: true })
  arrivalCoordinates: [number, number];

  @ApiProperty()
  @IsDateString()
  @IsNotEmpty()
  departureDate: string;

  @ApiProperty({ minimum: 1 })
  @IsNumber()
  @Min(1)
  @IsNotEmpty()
  availableSeats: number;

  @ApiProperty({ 
    minimum: 0,
    description: 'Prix par place en francs congolais. Mettre 0 pour un trajet gratuit.',
    example: 0,
  })
  @IsNumber()
  @Min(0)
  pricePerSeat: number;

  @ApiProperty({ 
    required: false,
    default: false,
    description: 'Indique si le trajet est gratuit. Si true, pricePerSeat sera automatiquement mis à 0.',
    example: false,
  })
  @IsBoolean()
  @IsOptional()
  isFree?: boolean;

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiProperty({
    required: false,
    description: 'ID du véhicule à associer au trajet (doit appartenir au driver)',
  })
  @IsString()
  @IsOptional()
  vehicleId?: string;
}

export class SearchTripsDto {
  @ApiProperty({
    required: false,
    description: 'Nom du lieu de départ (recherche textuelle)',
  })
  @IsString()
  @IsOptional()
  departureLocation?: string;

  @ApiProperty({
    required: false,
    description: 'Coordonnées du point de départ [longitude, latitude]. Peut être utilisé seul ou avec arrivalCoordinates.',
    example: [15.2663, -4.325],
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(2)
  @IsNumber({}, { each: true })
  departureCoordinates?: [number, number];

  @ApiProperty({
    required: false,
    description: 'Nom du lieu d\'arrivée (recherche textuelle)',
  })
  @IsString()
  @IsOptional()
  arrivalLocation?: string;

  @ApiProperty({
    required: false,
    description: 'Coordonnées du point d\'arrivée [longitude, latitude]. Peut être utilisé seul ou avec departureCoordinates.',
    example: [15.3222, -4.4419],
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(2)
  @IsNumber({}, { each: true })
  arrivalCoordinates?: [number, number];

  @ApiProperty({
    required: false,
    minimum: 1,
    description: 'Rayon de recherche autour du point de départ en kilomètres (défaut: 50 km). Optionnel si departureCoordinates est fourni.',
    default: 50,
  })
  @IsNumber()
  @Min(1)
  @IsOptional()
  departureRadiusKm?: number;

  @ApiProperty({
    required: false,
    minimum: 1,
    description: 'Rayon de recherche autour du point d\'arrivée en kilomètres (défaut: 50 km). Optionnel si arrivalCoordinates est fourni.',
    default: 50,
  })
  @IsNumber()
  @Min(1)
  @IsOptional()
  arrivalRadiusKm?: number;

  @ApiProperty({ required: false })
  @IsDateString()
  @IsOptional()
  departureDate?: string;

  @ApiProperty({ required: false, minimum: 1 })
  @IsNumber()
  @Min(1)
  @IsOptional()
  minSeats?: number;

  @ApiProperty({ required: false, minimum: 0 })
  @IsNumber()
  @Min(0)
  @IsOptional()
  maxPrice?: number;

  @ApiProperty({ 
    required: false,
    description: 'Filtrer uniquement les trajets gratuits',
    example: false,
  })
  @IsBoolean()
  @IsOptional()
  isFree?: boolean;
}

export class UpdateTripDto {
  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  departureLocation?: string;

  @ApiProperty({
    required: false,
    description: 'Nouvelles coordonnées de départ [longitude, latitude]',
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(2)
  @IsNumber({}, { each: true })
  departureCoordinates?: [number, number];

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  arrivalLocation?: string;

  @ApiProperty({
    required: false,
    description: 'Nouvelles coordonnées d’arrivée [longitude, latitude]',
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(2)
  @IsNumber({}, { each: true })
  arrivalCoordinates?: [number, number];

  @ApiProperty({ required: false })
  @IsDateString()
  @IsOptional()
  departureDate?: string;

  @ApiProperty({ required: false, minimum: 1 })
  @IsNumber()
  @Min(1)
  @IsOptional()
  availableSeats?: number;

  @ApiProperty({ required: false, minimum: 0 })
  @IsNumber()
  @Min(0)
  @IsOptional()
  pricePerSeat?: number;

  @ApiProperty({ 
    required: false,
    description: 'Indique si le trajet est gratuit. Si true, pricePerSeat sera automatiquement mis à 0.',
    example: false,
  })
  @IsBoolean()
  @IsOptional()
  isFree?: boolean;

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiProperty({ required: false, enum: TripStatus })
  @IsEnum(TripStatus)
  @IsOptional()
  status?: TripStatus;

  @ApiProperty({
    required: false,
    description: 'ID du véhicule à associer au trajet (doit appartenir au driver). Passer null pour retirer l\'association.',
  })
  @IsString()
  @IsOptional()
  vehicleId?: string | null;
}

export class SearchByPointsDto {
  @ApiProperty({
    required: false,
    description: 'Coordonnées du point de départ [longitude, latitude]. Peut être utilisé seul ou avec arrivalCoordinates.',
    example: [15.2663, -4.325],
    minItems: 2,
    maxItems: 2,
  })
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(2)
  @IsNumber({}, { each: true })
  @IsOptional()
  departureCoordinates?: [number, number];

  @ApiProperty({
    required: false,
    description: "Coordonnées du point d'arrivée [longitude, latitude]. Peut être utilisé seul ou avec departureCoordinates.",
    example: [15.3222, -4.4419],
    minItems: 2,
    maxItems: 2,
  })
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(2)
  @IsNumber({}, { each: true })
  @IsOptional()
  arrivalCoordinates?: [number, number];

  @ApiProperty({
    required: false,
    minimum: 1,
    description: 'Rayon de recherche autour du point de départ en kilomètres (défaut: 50 km). Optionnel si departureCoordinates est fourni.',
    default: 50,
  })
  @IsNumber()
  @Min(1)
  @IsOptional()
  departureRadiusKm?: number;

  @ApiProperty({
    required: false,
    minimum: 1,
    description: 'Rayon de recherche autour du point d\'arrivée en kilomètres (défaut: 50 km). Optionnel si arrivalCoordinates est fourni.',
    default: 50,
  })
  @IsNumber()
  @Min(1)
  @IsOptional()
  arrivalRadiusKm?: number;

  @ApiProperty({ required: false })
  @IsDateString()
  @IsOptional()
  departureDate?: string;

  @ApiProperty({ required: false, minimum: 1 })
  @IsNumber()
  @Min(1)
  @IsOptional()
  minSeats?: number;

  @ApiProperty({ required: false, minimum: 0 })
  @IsNumber()
  @Min(0)
  @IsOptional()
  maxPrice?: number;
}

