import {
  IsString,
  IsNotEmpty,
  IsNumber,
  IsDateString,
  IsOptional,
  IsEnum,
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

  @ApiProperty({ minimum: 0 })
  @IsNumber()
  @Min(0)
  @IsNotEmpty()
  pricePerSeat: number;

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  description?: string;
}

export class SearchTripsDto {
  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  departureLocation?: string;

  @ApiProperty({
    required: false,
    description: 'Coordonnées du point de départ [longitude, latitude]',
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
    description: 'Coordonnées du point d’arrivée [longitude, latitude]',
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
    description: 'Rayon de recherche autour du point de départ (km)',
  })
  @IsNumber()
  @Min(1)
  @IsOptional()
  departureRadiusKm?: number;

  @ApiProperty({
    required: false,
    minimum: 1,
    description: 'Rayon de recherche autour du point d’arrivée (km)',
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

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiProperty({ required: false, enum: TripStatus })
  @IsEnum(TripStatus)
  @IsOptional()
  status?: TripStatus;
}

