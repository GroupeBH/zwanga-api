import { Transform, TransformFnParams, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { VehicleType } from '../../vehicles/entities/vehicle.entity';

// Read the original value: global implicit conversion must not turn "false"
// into true or accept a number/object in place of a text field.
const rawValue = ({ obj, key }: TransformFnParams) => obj[key];
const trimmedText = (params: TransformFnParams) => {
  const value = rawValue(params);
  return typeof value === 'string' ? value.trim() : value;
};

export class AdminVehiclesQueryDto {
  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER / 200)
  page: number = 1;

  @ApiPropertyOptional({ default: 25, minimum: 1, maximum: 200 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit: number = 25;

  @ApiPropertyOptional({ enum: VehicleType })
  @ValidateIf((_object, value) => value !== undefined)
  @Transform(rawValue)
  @IsEnum(VehicleType)
  vehicleType?: VehicleType;

  @ApiPropertyOptional({
    enum: ['true', 'false'],
    description: 'Omit to include active and inactive vehicles.',
  })
  @ValidateIf((_object, value) => value !== undefined)
  @Transform(rawValue)
  @IsIn(['true', 'false'])
  isActive?: 'true' | 'false';

  @ApiPropertyOptional({
    maxLength: 100,
    description: 'Matches plate, brand, model or owner name/phone.',
  })
  @ValidateIf((_object, value) => value !== undefined)
  @Transform(trimmedText)
  @IsString()
  @MaxLength(100)
  search?: string;
}

/** Admin-only patch. Ownership, IDs and timestamps can never be edited here. */
export class AdminUpdateVehicleDto {
  @ApiPropertyOptional({ maxLength: 100 })
  @ValidateIf((_object, value) => value !== undefined)
  @Transform(trimmedText)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  brand?: string;

  @ApiPropertyOptional({ maxLength: 100 })
  @ValidateIf((_object, value) => value !== undefined)
  @Transform(trimmedText)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  model?: string;

  @ApiPropertyOptional({ maxLength: 100 })
  @ValidateIf((_object, value) => value !== undefined)
  @Transform(trimmedText)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  color?: string;

  @ApiPropertyOptional({ enum: VehicleType })
  @ValidateIf((_object, value) => value !== undefined)
  @Transform(rawValue)
  @IsEnum(VehicleType)
  type?: VehicleType;

  @ApiPropertyOptional({ maxLength: 50 })
  @ValidateIf((_object, value) => value !== undefined)
  @Transform(trimmedText)
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  licensePlate?: string;

  @ApiPropertyOptional({
    maxLength: 2048,
    description: 'Existing image URL or uploaded vehicle image key.',
  })
  @ValidateIf((_object, value) => value !== undefined)
  @Transform(trimmedText)
  @IsString()
  @IsNotEmpty()
  @MaxLength(2048)
  photoUrl?: string;

  @ApiPropertyOptional({
    description:
      'false deactivates with the same trip checks as the dedicated endpoint.',
  })
  @ValidateIf((_object, value) => value !== undefined)
  @Transform(rawValue)
  @IsBoolean()
  isActive?: boolean;
}
