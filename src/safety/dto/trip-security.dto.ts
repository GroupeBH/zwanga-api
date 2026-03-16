import { ApiProperty } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { TripSafetyChannel } from '../entities/trip-safety-channel.enum';

export enum TripSecurityStartAction {
  IM_BOARDED = 'im_boarded',
  TRIP_STARTED = 'trip_started',
}

export enum TripSecurityConfirmationOutcome {
  ARRIVED = 'arrived',
  DROPPED_OFF = 'dropped_off',
  TRIP_ENDED = 'trip_ended',
}

export class StartTripSecurityTrackingDto {
  @ApiProperty({ description: 'ID du trajet concerné' })
  @IsUUID()
  @IsNotEmpty()
  tripId: string;

  @ApiProperty({
    description: 'ID de la réservation (obligatoire côté passager, non utilisé côté conducteur)',
    required: false,
  })
  @IsUUID()
  @IsOptional()
  bookingId?: string;

  @ApiProperty({
    description: 'Action utilisateur effectuée au démarrage',
    enum: TripSecurityStartAction,
    required: false,
    default: TripSecurityStartAction.IM_BOARDED,
  })
  @IsEnum(TripSecurityStartAction)
  @IsOptional()
  action?: TripSecurityStartAction;

  @ApiProperty({
    description: 'Contacts de confiance à notifier immédiatement',
    type: [String],
    required: false,
  })
  @IsArray()
  @IsUUID(undefined, { each: true })
  @IsOptional()
  trustedContactIds?: string[];

  @ApiProperty({
    description: 'Date/heure estimée de fin du trajet pour cette personne',
    required: false,
  })
  @IsDateString()
  @IsOptional()
  estimatedEndAt?: string;

  @ApiProperty({
    description: 'Délai (minutes) après fin estimée avant relance automatique',
    required: false,
    minimum: 1,
    maximum: 240,
  })
  @IsInt()
  @Min(1)
  @Max(240)
  @IsOptional()
  reminderDelayMinutes?: number;

  @ApiProperty({
    description: 'Délai (minutes) après relance avant escalade vers les proches',
    required: false,
    minimum: 1,
    maximum: 720,
  })
  @IsInt()
  @Min(1)
  @Max(720)
  @IsOptional()
  escalationDelayMinutes?: number;

  @ApiProperty({
    description: 'Canaux autorisés pour les notifications sécurité',
    enum: TripSafetyChannel,
    isArray: true,
    required: false,
  })
  @IsArray()
  @IsEnum(TripSafetyChannel, { each: true })
  @IsOptional()
  channels?: TripSafetyChannel[];

  @ApiProperty({
    description: 'Notifier automatiquement les proches dès le démarrage',
    required: false,
    default: true,
  })
  @IsBoolean()
  @IsOptional()
  notifyTrustedContacts?: boolean;
}

export class NotifyTrustedContactsDto {
  @ApiProperty({
    description: 'Limiter l’envoi à certains contacts (sinon tous les contacts associés au suivi)',
    type: [String],
    required: false,
  })
  @IsArray()
  @IsUUID(undefined, { each: true })
  @IsOptional()
  trustedContactIds?: string[];

  @ApiProperty({
    description: 'Canaux ciblés pour cet envoi',
    enum: TripSafetyChannel,
    isArray: true,
    required: false,
  })
  @IsArray()
  @IsEnum(TripSafetyChannel, { each: true })
  @IsOptional()
  channels?: TripSafetyChannel[];

  @ApiProperty({
    description: 'Message additionnel optionnel',
    required: false,
    maxLength: 500,
  })
  @IsString()
  @MaxLength(500)
  @IsOptional()
  customMessage?: string;
}

export class ConfirmTripSecurityDto {
  @ApiProperty({
    description: 'Confirmation explicite de fin pour la personne suivie',
    enum: TripSecurityConfirmationOutcome,
  })
  @IsEnum(TripSecurityConfirmationOutcome)
  outcome: TripSecurityConfirmationOutcome;

  @ApiProperty({
    description: 'Commentaire de confirmation optionnel',
    required: false,
    maxLength: 500,
  })
  @IsString()
  @MaxLength(500)
  @IsOptional()
  note?: string;
}

export class UpdateTripSecurityConfigurationDto {
  @ApiProperty({
    description: 'Nouveau délai de relance (minutes)',
    required: false,
    minimum: 1,
    maximum: 240,
  })
  @IsInt()
  @Min(1)
  @Max(240)
  @IsOptional()
  reminderDelayMinutes?: number;

  @ApiProperty({
    description: 'Nouveau délai avant escalade (minutes)',
    required: false,
    minimum: 1,
    maximum: 720,
  })
  @IsInt()
  @Min(1)
  @Max(720)
  @IsOptional()
  escalationDelayMinutes?: number;

  @ApiProperty({
    description: 'Canaux de notification actifs',
    enum: TripSafetyChannel,
    isArray: true,
    required: false,
  })
  @IsArray()
  @IsEnum(TripSafetyChannel, { each: true })
  @IsOptional()
  channels?: TripSafetyChannel[];
}

export class ManualEscalationDto {
  @ApiProperty({
    description: 'Motif de l’escalade manuelle',
    required: false,
    maxLength: 500,
  })
  @IsString()
  @MaxLength(500)
  @IsOptional()
  reason?: string;

  @ApiProperty({
    description: 'Canaux ciblés pour l’escalade',
    enum: TripSafetyChannel,
    isArray: true,
    required: false,
  })
  @IsArray()
  @IsEnum(TripSafetyChannel, { each: true })
  @IsOptional()
  channels?: TripSafetyChannel[];
}

export class CancelTripSecurityDto {
  @ApiProperty({
    description: 'Raison d’annulation du suivi',
    required: false,
    maxLength: 500,
  })
  @IsString()
  @MaxLength(500)
  @IsOptional()
  reason?: string;
}
