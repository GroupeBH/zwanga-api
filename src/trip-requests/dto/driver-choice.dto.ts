import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsEnum, IsInt, IsLatitude, IsLongitude, IsOptional, IsString, Max, MaxLength, Min, ValidateIf } from 'class-validator';
import { VehicleType } from '../../vehicles/entities/vehicle.entity';

export class DriverChoiceQuery {
  @Type(() => Number) @IsLatitude() latitude: number;
  @Type(() => Number) @IsLongitude() longitude: number;
  @ValidateIf(o => o.vehicleType !== undefined || o.vehicleTypes === undefined)
  @IsEnum(VehicleType) vehicleType?: VehicleType;
  @Transform(({ value }) => typeof value === 'string' ? value.split(',') : value)
  @ValidateIf(o => o.vehicleTypes !== undefined)
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(3) @ArrayUnique() @IsEnum(VehicleType, { each: true })
  vehicleTypes?: VehicleType[];
  @Type(() => Number) @IsInt() @Min(1) @Max(20) seats: number = 1;
  @IsOptional() @IsString() @MaxLength(80) search?: string;
}
