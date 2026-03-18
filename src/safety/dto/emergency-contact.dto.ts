import { ApiProperty } from '@nestjs/swagger';
import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsBoolean,
  Matches,
  IsArray,
  ValidateNested,
  ArrayMaxSize,
  ArrayMinSize,
  IsEmail,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CreateEmergencyContactDto {
  @ApiProperty({ description: "Nom du contact d'urgence" })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({ description: 'Numero de telephone du contact' })
  @IsString()
  @IsNotEmpty()
  @Matches(/^\+?[1-9]\d{1,14}$/, {
    message: 'Le numero de telephone doit etre au format international valide',
  })
  phone: string;

  @ApiProperty({ description: 'Email du contact', required: false })
  @IsEmail()
  @IsOptional()
  email?: string;

  @ApiProperty({ description: 'Relation avec le contact (famille, ami, etc.)', required: false })
  @IsString()
  @IsOptional()
  relationship?: string;
}

export class CreateMultipleEmergencyContactsDto {
  @ApiProperty({
    description: "Liste des contacts d'urgence a creer (maximum 5 au total par utilisateur)",
    type: [CreateEmergencyContactDto],
    example: [
      { name: 'Jean Dupont', phone: '+33612345678', relationship: 'Famille' },
      { name: 'Marie Martin', phone: '+33687654321', relationship: 'Ami' },
    ],
  })
  @IsArray()
  @ArrayMinSize(1, { message: 'Vous devez fournir au moins un contact' })
  @ArrayMaxSize(5, {
    message: 'Vous ne pouvez pas ajouter plus de 5 contacts en une seule fois',
  })
  @ValidateNested({ each: true })
  @Type(() => CreateEmergencyContactDto)
  contacts: CreateEmergencyContactDto[];
}

export class UpdateEmergencyContactDto {
  @ApiProperty({ description: "Nom du contact d'urgence", required: false })
  @IsString()
  @IsOptional()
  name?: string;

  @ApiProperty({ description: 'Numero de telephone du contact', required: false })
  @IsString()
  @IsOptional()
  @Matches(/^\+?[1-9]\d{1,14}$/, {
    message: 'Le numero de telephone doit etre au format international valide',
  })
  phone?: string;

  @ApiProperty({ description: 'Email du contact', required: false })
  @IsEmail()
  @IsOptional()
  email?: string;

  @ApiProperty({ description: 'Relation avec le contact', required: false })
  @IsString()
  @IsOptional()
  relationship?: string;

  @ApiProperty({ description: 'Si le contact est actif', required: false })
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}