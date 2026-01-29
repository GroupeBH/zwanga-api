import {
  IsString,
  IsNotEmpty,
  IsNumber,
  IsDateString,
  IsOptional,
  Min,
  IsArray,
  ArrayMinSize,
  ArrayMaxSize,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateTripRequestDto {
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
    description: 'Coordonnées du point d\'arrivée [longitude, latitude]',
    example: [15.3222, -4.4419],
    minItems: 2,
    maxItems: 2,
  })
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(2)
  @IsNumber({}, { each: true })
  arrivalCoordinates: [number, number];

  @ApiProperty({
    description: 'Date/heure de départ minimum souhaitée',
    example: '2025-12-20T08:00:00Z',
  })
  @IsDateString()
  @IsNotEmpty()
  departureDateMin: string;

  @ApiProperty({
    description: 'Date/heure de départ maximum acceptée (délai)',
    example: '2025-12-20T18:00:00Z',
  })
  @IsDateString()
  @IsNotEmpty()
  departureDateMax: string;

  @ApiProperty({ 
    minimum: 1,
    description: 'Nombre de places nécessaires',
    example: 2,
  })
  @IsNumber()
  @Min(1)
  @IsNotEmpty()
  numberOfSeats: number;

  @ApiProperty({ 
    required: false,
    minimum: 0,
    description: 'Prix maximum par place accepté (optionnel)',
    example: 5000,
  })
  @IsNumber()
  @Min(0)
  @IsOptional()
  maxPricePerSeat?: number;

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  description?: string;
}

export class CreateDriverOfferDto {
  @ApiProperty({
    description: 'Date/heure de départ proposée par le driver',
    example: '2025-12-20T10:00:00Z',
  })
  @IsDateString()
  @IsNotEmpty()
  proposedDepartureDate: string;

  @ApiProperty({ 
    minimum: 0,
    description: 'Prix proposé par place',
    example: 4500,
  })
  @IsNumber()
  @Min(0)
  @IsNotEmpty()
  pricePerSeat: number;

  @ApiProperty({ 
    minimum: 1,
    description: 'Nombre de places disponibles',
    example: 4,
  })
  @IsNumber()
  @Min(1)
  @IsNotEmpty()
  availableSeats: number;

  @ApiProperty({
    required: false,
    description: 'ID du véhicule à utiliser (doit appartenir au driver)',
  })
  @IsString()
  @IsOptional()
  vehicleId?: string;

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  message?: string;
}

export class AcceptDriverOfferDto {
  @ApiProperty({
    description: 'ID de l\'offre du driver à accepter',
  })
  @IsString()
  @IsNotEmpty()
  offerId: string;
}

export class AcceptTripRequestDto {
  @ApiProperty({
    required: false,
    description: 'ID du véhicule à utiliser (doit appartenir au driver). Si non fourni, le premier véhicule actif sera utilisé.',
  })
  @IsString()
  @IsOptional()
  vehicleId?: string;

  @ApiProperty({
    minimum: 0,
    description: 'Prix par place proposé par le driver',
    example: 4500,
  })
  @IsNumber()
  @Min(0)
  @IsNotEmpty()
  pricePerSeat: number;

  @ApiProperty({
    required: false,
    description: 'Date/heure de départ proposée. Si non fournie, utilise la date minimum de la demande.',
    example: '2025-12-20T10:00:00Z',
  })
  @IsDateString()
  @IsOptional()
  departureDate?: string;

  @ApiProperty({
    minimum: 1,
    description: 'Nombre total de places disponibles dans le véhicule. Doit être au moins égal au nombre de places demandées.',
    example: 4,
  })
  @IsNumber()
  @Min(1)
  @IsNotEmpty()
  totalSeats: number;
}

export class UpdateTripRequestDto {
  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  departureLocation?: string;

  @ApiProperty({
    required: false,
    description: 'Coordonnées du point de départ [longitude, latitude]',
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

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  arrivalLocation?: string;

  @ApiProperty({
    required: false,
    description: 'Coordonnées du point d\'arrivée [longitude, latitude]',
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
    description: 'Date/heure de départ minimum souhaitée',
    example: '2025-12-20T08:00:00Z',
  })
  @IsDateString()
  @IsOptional()
  departureDateMin?: string;

  @ApiProperty({
    required: false,
    description: 'Date/heure de départ maximum acceptée (délai)',
    example: '2025-12-20T18:00:00Z',
  })
  @IsDateString()
  @IsOptional()
  departureDateMax?: string;

  @ApiProperty({ 
    required: false,
    minimum: 1,
    description: 'Nombre de places nécessaires',
    example: 2,
  })
  @IsNumber()
  @Min(1)
  @IsOptional()
  numberOfSeats?: number;

  @ApiProperty({ 
    required: false,
    minimum: 0,
    description: 'Prix maximum par place accepté (optionnel)',
    example: 5000,
  })
  @IsNumber()
  @Min(0)
  @IsOptional()
  maxPricePerSeat?: number;

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  description?: string;
}

