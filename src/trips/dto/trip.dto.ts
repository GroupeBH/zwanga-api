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
  IsUUID,
  IsInt,
  Matches,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { TripStatus } from '../entities/trip.entity';
import { RecurringTripTemplateStatus } from '../entities/recurring-trip-template.entity';

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

  @ApiProperty({ minimum: 1, description: 'Nombre total de places disponibles dans le véhicule' })
  @IsNumber()
  @Min(1)
  @IsNotEmpty()
  totalSeats: number;

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
    description: "Mots-cles de recherche. Chaque mot est teste sur l'adresse de depart ou d'arrivee.",
    example: 'gombe aeroport',
  })
  @IsString()
  @IsOptional()
  keywords?: string;

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

  @ApiProperty({ required: false, minimum: 1, description: 'Nombre total de places (si modifié, availableSeats sera recalculé)' })
  @IsNumber()
  @Min(1)
  @IsOptional()
  totalSeats?: number;

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

export class DriverEmergencyContactsDto {
  @ApiProperty({
    description: "IDs des contacts d'urgence du conducteur a notifier (1 a 5 contacts)",
    type: [String],
    minItems: 1,
    maxItems: 5,
  })
  @IsArray()
  @ArrayMinSize(1, { message: "Vous devez selectionner au moins 1 contact d'urgence" })
  @ArrayMaxSize(5, { message: "Vous ne pouvez pas selectionner plus de 5 contacts d'urgence" })
  @IsUUID(undefined, { each: true, message: 'Chaque ID de contact doit etre un UUID valide' })
  emergencyContactIds: string[];
}

export class CreateRecurringTripDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  departureLocation: string;

  @ApiProperty({
    description: 'Coordonnees du point de depart [longitude, latitude]',
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
    description: "Coordonnees du point d'arrivee [longitude, latitude]",
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
    description: 'Date de debut du schema recurrent (format YYYY-MM-DD)',
    example: '2026-03-30',
  })
  @IsDateString()
  @IsNotEmpty()
  startDate: string;

  @ApiProperty({
    required: false,
    description: 'Date de fin optionnelle du schema recurrent (format YYYY-MM-DD)',
    example: '2026-06-30',
  })
  @IsDateString()
  @IsOptional()
  endDate?: string;

  @ApiProperty({
    description: 'Heure de depart quotidienne (format HH:mm)',
    example: '07:30',
  })
  @Matches(/^([01]\d|2[0-3]):([0-5]\d)$/)
  @IsNotEmpty()
  departureTime: string;

  @ApiProperty({
    description: 'Jours de repetition ISO (1 = lundi, 7 = dimanche)',
    example: [1, 2, 3, 4, 5],
    type: [Number],
    minItems: 1,
    maxItems: 7,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(7)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(7, { each: true })
  weekdays: number[];

  @ApiProperty({ minimum: 1, description: 'Nombre total de places disponibles dans le vehicule' })
  @IsNumber()
  @Min(1)
  @IsNotEmpty()
  totalSeats: number;

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
    description: 'Indique si le trajet recurrent est gratuit.',
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
    description: 'ID du vehicule a associer au schema recurrent',
  })
  @IsString()
  @IsNotEmpty()
  vehicleId: string;
}

export class UpdateRecurringTripStatusDto {
  @ApiProperty({ enum: RecurringTripTemplateStatus })
  @IsEnum(RecurringTripTemplateStatus)
  status: RecurringTripTemplateStatus;
}

export class SearchByPointsDto {
  @ApiProperty({
    required: false,
    description: "Mots-cles de recherche. Chaque mot est teste sur l'adresse de depart ou d'arrivee.",
    example: 'gombe aeroport',
  })
  @IsString()
  @IsOptional()
  keywords?: string;

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

