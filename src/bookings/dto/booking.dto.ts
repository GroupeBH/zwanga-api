import {
  IsString,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsEnum,
  Min,
  Max,
  ValidateNested,
  IsBoolean,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { BookingStatus } from '../entities/booking.entity';
import { ReportReason } from '../../safety/entities/user-report.entity';
import { TripPaymentMode } from '../../payments/enums/trip-payment-mode.enum';

class PassengerDestinationCoordinatesDto {
  @ApiProperty({
    description: 'Latitude de la destination du passager',
    example: -4.3276,
  })
  @IsNumber()
  @IsNotEmpty()
  latitude: number;

  @ApiProperty({
    description: 'Longitude de la destination du passager',
    example: 15.3136,
  })
  @IsNumber()
  @IsNotEmpty()
  longitude: number;
}

class PassengerOriginCoordinatesDto {
  @ApiProperty({
    description: 'Latitude du point de départ du passager',
    example: -4.3276,
  })
  @IsNumber()
  @IsNotEmpty()
  latitude: number;

  @ApiProperty({
    description: 'Longitude du point de départ du passager',
    example: 15.3136,
  })
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
    maximum: 2,
    description:
      'Nombre de places à réserver. Maximum 2 places par réservation pour des raisons de sécurité du conducteur.',
  })
  @IsNumber()
  @Min(1, { message: 'Le nombre de places doit être au moins 1' })
  @Max(2, {
    message:
      'Pour des raisons de sécurité du conducteur, vous ne pouvez pas réserver plus de 2 places par trajet',
  })
  @IsNotEmpty()
  numberOfSeats: number;

  @ApiProperty({
    description:
      'Point de départ du passager (optionnel - si non spécifié, utilise le point de départ du trajet)',
    required: false,
    example: 'Centre-ville de Kinshasa',
  })
  @IsString()
  @IsOptional()
  passengerOrigin?: string;

  @ApiProperty({
    description:
      'Reference ou repere connu pour faciliter la prise en charge du passager',
    required: false,
    example: 'Devant la pharmacie, portail bleu',
  })
  @IsString()
  @IsOptional()
  passengerOriginReference?: string;

  @ApiProperty({
    description:
      'Coordonnées géographiques du point de départ du passager (optionnel)',
    required: false,
    type: PassengerOriginCoordinatesDto,
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => PassengerOriginCoordinatesDto)
  passengerOriginCoordinates?: PassengerOriginCoordinatesDto;

  @ApiProperty({
    description:
      'Destination du passager (optionnel - si non spécifié, utilise la destination du trajet)',
    required: false,
    example: 'Aéroport de Kinshasa',
  })
  @IsString()
  @IsOptional()
  passengerDestination?: string;

  @ApiProperty({
    description:
      'Reference ou repere connu pour faciliter la depose du passager',
    required: false,
    example: 'Entree principale, pres du rond-point',
  })
  @IsString()
  @IsOptional()
  passengerDestinationReference?: string;

  @ApiProperty({
    description:
      'Coordonnées géographiques de la destination du passager (optionnel)',
    required: false,
    type: PassengerDestinationCoordinatesDto,
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => PassengerDestinationCoordinatesDto)
  passengerDestinationCoordinates?: PassengerDestinationCoordinatesDto;

  @ApiProperty({
    required: false,
    enum: TripPaymentMode,
    enumName: 'TripPaymentMode',
    description:
      'Mode de reglement du trajet: paiement electronique via FlexPay, points Zwanga ou paiement physique a l arrivee',
    example: TripPaymentMode.ELECTRONIC,
  })
  @IsEnum(TripPaymentMode, {
    message: 'Le mode de paiement selectionne est invalide',
  })
  @IsOptional()
  paymentMode?: TripPaymentMode;
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
  @ApiProperty({
    description: 'Confirmer la récupération du passager',
    example: true,
  })
  @IsOptional()
  confirmed?: boolean; // Pour compatibilité, mais toujours true quand appelé
}

export class ConfirmDropoffDto {
  @ApiProperty({
    description: 'Confirmer la dépose du passager',
    example: true,
  })
  @IsOptional()
  confirmed?: boolean; // Pour compatibilité, mais toujours true quand appelé
  @ApiProperty({
    required: false,
    enum: TripPaymentMode,
    enumName: 'TripPaymentMode',
    description:
      'Mode de reglement choisi au moment de la depose: paiement electronique, points Zwanga ou paiement physique',
    example: TripPaymentMode.CASH,
  })
  @IsEnum(TripPaymentMode, {
    message: 'Le mode de paiement selectionne est invalide',
  })
  @IsOptional()
  paymentMode?: TripPaymentMode;
}

export class UpdateBookingPaymentModeDto {
  @ApiProperty({
    enum: TripPaymentMode,
    enumName: 'TripPaymentMode',
    description:
      'Nouveau mode de reglement du trajet: paiement electronique via FlexPay, points Zwanga ou paiement physique',
    example: TripPaymentMode.CASH,
  })
  @IsEnum(TripPaymentMode, {
    message: 'Le mode de paiement selectionne est invalide',
  })
  @IsNotEmpty()
  paymentMode: TripPaymentMode;
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
  @ApiProperty({
    description: 'Latitude de la position actuelle du passager',
    example: -4.3276,
  })
  @IsNumber()
  @IsNotEmpty()
  latitude: number;

  @ApiProperty({
    description: 'Longitude de la position actuelle du passager',
    example: 15.3136,
  })
  @IsNumber()
  @IsNotEmpty()
  longitude: number;
}
