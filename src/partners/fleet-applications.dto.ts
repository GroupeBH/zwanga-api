import { Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from 'class-validator';

export class FleetApplicationPageDto {
  @Type(() => Number) @IsInt() @Min(1) @Max(10000) page = 1;
  @Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 20;
}
export class FleetDirectoryDto extends FleetApplicationPageDto {
  @IsOptional() @IsString() @Length(0, 100) search?: string;
}
export class FleetApplicationsQueryDto extends FleetApplicationPageDto {
  @IsOptional()
  @IsIn(['PENDING', 'ACCEPTED', 'REJECTED', 'WITHDRAWN'])
  status?: string;
}
export class ApplyToFleetDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Length(10, 2000)
  message: string;
}
export class ReviewFleetApplicationDto {
  @IsIn(['ACCEPTED', 'REJECTED']) status: 'ACCEPTED' | 'REJECTED';
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Length(0, 1000)
  note?: string;
}
