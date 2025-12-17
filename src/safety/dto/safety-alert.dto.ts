import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, IsNumber, IsUUID, Min, Max, IsLatitude, IsLongitude } from 'class-validator';
import { SafetyAlertType } from '../entities/safety-alert.entity';

export class CreateSafetyAlertDto {
  @ApiProperty({ description: 'Type d\'alerte', enum: SafetyAlertType })
  @IsEnum(SafetyAlertType)
  type: SafetyAlertType;

  @ApiProperty({ description: 'Message optionnel', required: false })
  @IsString()
  @IsOptional()
  message?: string;

  @ApiProperty({ description: 'Latitude GPS', required: false })
  @IsLatitude()
  @IsOptional()
  latitude?: number;

  @ApiProperty({ description: 'Longitude GPS', required: false })
  @IsLongitude()
  @IsOptional()
  longitude?: number;

  @ApiProperty({ description: 'Niveau de batterie (%)', required: false, minimum: 0, maximum: 100 })
  @IsNumber()
  @Min(0)
  @Max(100)
  @IsOptional()
  batteryLevel?: number;

  @ApiProperty({ description: 'ID du trip associé', required: false })
  @IsUUID()
  @IsOptional()
  tripId?: string;

  @ApiProperty({ description: 'ID du booking associé', required: false })
  @IsUUID()
  @IsOptional()
  bookingId?: string;
}

export class UpdateSafetyAlertStatusDto {
  @ApiProperty({ description: 'Nouveau statut de l\'alerte', enum: ['resolved', 'false_alarm'] })
  @IsEnum(['resolved', 'false_alarm'])
  status: 'resolved' | 'false_alarm';
}

export class UpdateLocationDto {
  @ApiProperty({ description: 'Latitude GPS' })
  @IsLatitude()
  latitude: number;

  @ApiProperty({ description: 'Longitude GPS' })
  @IsLongitude()
  longitude: number;

  @ApiProperty({ description: 'Niveau de batterie (%)', required: false, minimum: 0, maximum: 100 })
  @IsNumber()
  @Min(0)
  @Max(100)
  @IsOptional()
  batteryLevel?: number;

  @ApiProperty({ description: 'ID du trip associé', required: false })
  @IsUUID()
  @IsOptional()
  tripId?: string;

  @ApiProperty({ description: 'ID du booking associé', required: false })
  @IsUUID()
  @IsOptional()
  bookingId?: string;
}

