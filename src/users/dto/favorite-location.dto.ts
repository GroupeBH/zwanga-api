import { IsString, IsEnum, IsOptional, IsBoolean, IsLatitude, IsLongitude, IsNotEmpty, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { FavoriteLocationType } from '../entities/favorite-location.entity';

export class CoordinatesDto {
  @ApiProperty({ description: 'Latitude' })
  @IsLatitude()
  latitude: number;

  @ApiProperty({ description: 'Longitude' })
  @IsLongitude()
  longitude: number;
}

export class CreateFavoriteLocationDto {
  @ApiProperty({ description: 'Name of the location (e.g., "Domicile", "Bureau")' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;

  @ApiProperty({ description: 'Full address' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  address: string;

  @ApiProperty({ description: 'Coordinates of the location', type: CoordinatesDto })
  @IsNotEmpty()
  coordinates: CoordinatesDto;

  @ApiPropertyOptional({ enum: FavoriteLocationType, default: FavoriteLocationType.OTHER })
  @IsOptional()
  @IsEnum(FavoriteLocationType)
  type?: FavoriteLocationType;

  @ApiPropertyOptional({ description: 'Set as default location for this type' })
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;

  @ApiPropertyOptional({ description: 'Optional notes about this location' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

export class UpdateFavoriteLocationDto {
  @ApiPropertyOptional({ description: 'Name of the location' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional({ description: 'Full address' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  address?: string;

  @ApiPropertyOptional({ description: 'Coordinates of the location', type: CoordinatesDto })
  @IsOptional()
  coordinates?: CoordinatesDto;

  @ApiPropertyOptional({ enum: FavoriteLocationType })
  @IsOptional()
  @IsEnum(FavoriteLocationType)
  type?: FavoriteLocationType;

  @ApiPropertyOptional({ description: 'Set as default location for this type' })
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;

  @ApiPropertyOptional({ description: 'Optional notes about this location' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

export class FavoriteLocationResponse {
  @ApiProperty()
  id: string;

  @ApiProperty()
  name: string;

  @ApiProperty()
  address: string;

  @ApiProperty({ type: CoordinatesDto })
  coordinates: CoordinatesDto;

  @ApiProperty({ enum: FavoriteLocationType })
  type: FavoriteLocationType;

  @ApiProperty()
  isDefault: boolean;

  @ApiPropertyOptional()
  notes?: string | null;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}

