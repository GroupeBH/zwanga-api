import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class RequestDiscoveryQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(1000) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50) minSeats?: number;
  @IsOptional() @IsIn(['soon', 'cheap', 'nearby']) sort?: 'soon' | 'cheap' | 'nearby';
  @IsOptional() @IsString() @MaxLength(100) search?: string;
}
