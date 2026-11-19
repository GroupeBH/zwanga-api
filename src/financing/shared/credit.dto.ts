import { IsUUID, IsOptional, IsInt, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';

export class CreditMutationDto {
  @IsUUID() mutationId: string;
}

export class CreditPageDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 25;
  @IsOptional() @IsUUID() after?: string;
}
