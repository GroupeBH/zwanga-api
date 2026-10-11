import { IsInt, IsString, IsOptional, IsUUID, Min, Max, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateRatingDto {
  @ApiProperty()
  @IsUUID()
  ratedUserId: string;

  @ApiProperty({ required: false })
  @IsUUID()
  @IsOptional()
  tripId?: string;

  @ApiProperty({ minimum: 1, maximum: 5 })
  @IsInt()
  @Min(1)
  @Max(5)
  rating: number;

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  @MaxLength(2000)
  comment?: string;
}

