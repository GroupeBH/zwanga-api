import { IsString, IsEnum, IsOptional, IsBoolean, IsLatitude, IsLongitude, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { FavoritePlaceType } from '../entities/favorite-place.entity';

export class CoordinatesDto {
  @ApiProperty({ description: 'Latitude' })
  @IsLatitude()
  latitude: number;

  @ApiProperty({ description: 'Longitude' })
  @IsLongitude()
  longitude: number;
}

export class CreateFavoritePlaceDto {
  @ApiProperty({ description: 'Name of the place (e.g., "Domicile", "Bureau")' })
  @IsString()
  name: string;

  @ApiProperty({ description: 'Full address' })
  @IsString()
  address: string;

  @ApiProperty({ description: 'Coordinates of the place', type: CoordinatesDto })
  @ValidateNested()
  @Type(() => CoordinatesDto)
  coordinates: CoordinatesDto;

  @ApiPropertyOptional({ enum: FavoritePlaceType, default: FavoritePlaceType.OTHER })
  @IsOptional()
  @IsEnum(FavoritePlaceType)
  type?: FavoritePlaceType;

  @ApiPropertyOptional({ description: 'Set as default place for this type', default: false })
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;

  @ApiPropertyOptional({ description: 'Google Maps Place ID' })
  @IsOptional()
  @IsString()
  placeId?: string;

  @ApiPropertyOptional({ description: 'Additional landmark notes shown to the user' })
  @IsOptional()
  @IsString()
  notes?: string;
}

export class UpdateFavoritePlaceDto {
  @ApiPropertyOptional({ description: 'Name of the place' })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({ description: 'Full address' })
  @IsOptional()
  @IsString()
  address?: string;

  @ApiPropertyOptional({ description: 'Coordinates of the place', type: CoordinatesDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => CoordinatesDto)
  coordinates?: CoordinatesDto;

  @ApiPropertyOptional({ enum: FavoritePlaceType })
  @IsOptional()
  @IsEnum(FavoritePlaceType)
  type?: FavoritePlaceType;

  @ApiPropertyOptional({ description: 'Set as default place for this type' })
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;

  @ApiPropertyOptional({ description: 'Google Maps Place ID' })
  @IsOptional()
  @IsString()
  placeId?: string;

  @ApiPropertyOptional({ description: 'Additional landmark notes shown to the user' })
  @IsOptional()
  @IsString()
  notes?: string;
}

export class FavoritePlaceResponse {
  @ApiProperty()
  id: string;

  @ApiProperty()
  name: string;

  @ApiProperty()
  address: string;

  @ApiProperty({ type: CoordinatesDto })
  coordinates: CoordinatesDto;

  @ApiProperty({ enum: FavoritePlaceType })
  type: FavoritePlaceType;

  @ApiProperty()
  isDefault: boolean;

  @ApiPropertyOptional()
  placeId?: string | null;

  @ApiPropertyOptional()
  notes?: string | null;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}

