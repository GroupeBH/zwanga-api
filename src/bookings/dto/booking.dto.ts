import { IsString, IsNotEmpty, IsNumber, IsOptional, IsEnum, Min, Max, ValidateNested, IsBoolean } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { BookingStatus } from '../entities/booking.entity';
import { ReportReason } from '../../safety/entities/user-report.entity';

class PassengerDestinationCoordinatesDto {
  @ApiProperty({ description: 'Latitude de la destination du passager', example: -4.3276 })
  @IsNumber()
  @IsNotEmpty()
  latitude: number;

  @ApiProperty({ description: 'Longitude de la destination du passager', example: 15.3136 })
  @IsNumber()
  @IsNotEmpty()
  longitude: number;
}

class PassengerOriginCoordinatesDto {
  @ApiProperty({ description: 'Latitude du point de départ du passager', example: -4.3276 })
  @IsNumber()
  @IsNotEmpty()
  latitude: number;

  @ApiProperty({ description: 'Longitude du point de départ du passager', example: 15.3136 })
  @IsNumber()
  @IsNotEmpty()
  longitude: number;
}

export class CreateBookingDto {
  @ApiProperty({ description: 'ID du trajet' })
  @IsString()
  @IsNotEmpty()
  tripId: string;

  @ApiProperty({ 
    minimum: 1,
    maximum: 50,
    description: 'Nombre de places à réserver. Le maximum est limité par le nombre de places disponibles dans le trajet (maximum 50 places par réservation).' 
  })
  @IsNumber()
  @Min(1, { message: 'Le nombre de places doit être au moins 1' })
  @Max(50, { message: 'Le nombre de places ne peut pas dépasser 50 par réservation' })
  @IsNotEmpty()
  numberOfSeats: number;

  @ApiProperty({ 
    description: 'Point de départ du passager (optionnel - si non spécifié, utilise le point de départ du trajet)', 
    required: false,
    example: 'Centre-ville de Kinshasa'
  })
  @IsString()
  @IsOptional()
  passengerOrigin?: string;

  @ApiProperty({ 
    description: 'Coordonnées géographiques du point de départ du passager (optionnel)', 
    required: false,
    type: PassengerOriginCoordinatesDto
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => PassengerOriginCoordinatesDto)
  passengerOriginCoordinates?: PassengerOriginCoordinatesDto;

  @ApiProperty({ 
    description: 'Destination du passager (optionnel - si non spécifié, utilise la destination du trajet)', 
    required: false,
    example: 'Aéroport de Kinshasa'
  })
  @IsString()
  @IsOptional()
  passengerDestination?: string;

  @ApiProperty({ 
    description: 'Coordonnées géographiques de la destination du passager (optionnel)', 
    required: false,
    type: PassengerDestinationCoordinatesDto
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => PassengerDestinationCoordinatesDto)
  passengerDestinationCoordinates?: PassengerDestinationCoordinatesDto;
}

export class UpdateBookingStatusDto {
  @ApiProperty({ enum: BookingStatus })
  @IsEnum(BookingStatus)
  @IsNotEmpty()
  status: BookingStatus;

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  rejectionReason?: string;
}

export class RejectBookingDto {
  @ApiProperty({ example: 'Le véhicule est déjà complet' })
  @IsString()
  @IsNotEmpty()
  reason: string;
}

export class ConfirmPickupDto {
  @ApiProperty({ description: 'Confirmer la récupération du passager', example: true })
  @IsOptional()
  confirmed?: boolean; // Pour compatibilité, mais toujours true quand appelé
}

export class ConfirmDropoffDto {
  @ApiProperty({ description: 'Confirmer la dépose du passager', example: true })
  @IsOptional()
  confirmed?: boolean; // Pour compatibilité, mais toujours true quand appelé
}

export class ReportBookingProblemDto {
  @ApiProperty({ description: 'Raison du signalement', enum: ReportReason })
  @IsEnum(ReportReason)
  @IsNotEmpty()
  reason: ReportReason;

  @ApiProperty({ description: 'Description détaillée du problème' })
  @IsString()
  @IsNotEmpty()
  description: string;
}

export class UpdatePassengerLocationDto {
  @ApiProperty({ description: 'Latitude de la position actuelle du passager', example: -4.3276 })
  @IsNumber()
  @IsNotEmpty()
  latitude: number;

  @ApiProperty({ description: 'Longitude de la position actuelle du passager', example: 15.3136 })
  @IsNumber()
  @IsNotEmpty()
  longitude: number;
}

