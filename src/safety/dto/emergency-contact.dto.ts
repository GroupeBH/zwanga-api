import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional, IsBoolean, Matches } from 'class-validator';

export class CreateEmergencyContactDto {
  @ApiProperty({ description: 'Nom du contact d\'urgence' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({ description: 'Numéro de téléphone du contact' })
  @IsString()
  @IsNotEmpty()
  @Matches(/^\+?[1-9]\d{1,14}$/, { message: 'Le numéro de téléphone doit être au format international valide' })
  phone: string;

  @ApiProperty({ description: 'Relation avec le contact (famille, ami, etc.)', required: false })
  @IsString()
  @IsOptional()
  relationship?: string;
}

export class UpdateEmergencyContactDto {
  @ApiProperty({ description: 'Nom du contact d\'urgence', required: false })
  @IsString()
  @IsOptional()
  name?: string;

  @ApiProperty({ description: 'Numéro de téléphone du contact', required: false })
  @IsString()
  @IsOptional()
  @Matches(/^\+?[1-9]\d{1,14}$/, { message: 'Le numéro de téléphone doit être au format international valide' })
  phone?: string;

  @ApiProperty({ description: 'Relation avec le contact', required: false })
  @IsString()
  @IsOptional()
  relationship?: string;

  @ApiProperty({ description: 'Si le contact est actif', required: false })
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}

