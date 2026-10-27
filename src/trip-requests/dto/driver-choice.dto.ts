import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsLatitude, IsLongitude, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { VehicleType } from '../../vehicles/entities/vehicle.entity';

export class DriverChoiceQuery {
  @Type(() => Number) @IsLatitude() latitude: number;
  @Type(() => Number) @IsLongitude() longitude: number;
  @IsEnum(VehicleType) vehicleType: VehicleType;
  @Type(() => Number) @IsInt() @Min(1) @Max(20) seats: number = 1;
  @IsOptional() @IsString() @MaxLength(80) search?: string;
}
