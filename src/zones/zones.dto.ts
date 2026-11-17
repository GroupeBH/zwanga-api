import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ZonePageDto {
  @ApiPropertyOptional({ default: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10000)
  page = 1;
  @ApiPropertyOptional({ default: 20, maximum: 100 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 20;
}
export class SaveZoneDto {
  @ApiProperty() @IsString() @Length(2, 100) name: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(0, 1000)
  description = '';
  @ApiProperty({
    description: 'GeoJSON Polygon ou MultiPolygon, WGS84 [longitude, latitude]',
  })
  @IsObject()
  geometry: Record<string, unknown>;
  @ApiPropertyOptional({ default: true })
  @Transform(({ obj, key }) => obj[key])
  @IsBoolean()
  active = true;
  @ApiPropertyOptional({ default: 0 })
  @IsInt()
  @Min(-1000)
  @Max(1000)
  priority = 0;
}
export class UpdateZoneDto extends SaveZoneDto {
  @ApiProperty({
    description:
      'Version lue, protection contre les modifications concurrentes',
  })
  @IsInt()
  @Min(1)
  version: number;
}

export class ZoneSettingsDto {
  @ApiProperty()
  @Transform(({ obj, key }) => obj[key])
  @IsBoolean()
  enabled: boolean;

  @ApiProperty({
    description: 'Version du réglage lue dans /admin/zones/status',
  })
  @IsInt()
  @Min(1)
  version: number;
}
