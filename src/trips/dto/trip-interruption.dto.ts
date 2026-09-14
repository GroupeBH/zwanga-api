import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  IsIn,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { TripInterruptionReason } from '../entities/trip-interruption.entity';

export class TripInterruptionCoordinatesDto {
  @ApiProperty({ example: -4.3276 })
  @IsNumber()
  @Min(-90)
  @Max(90)
  latitude: number;

  @ApiProperty({ example: 15.3136 })
  @IsNumber()
  @Min(-180)
  @Max(180)
  longitude: number;
}

export class RequestTripInterruptionDto {
  @ApiProperty({
    enum: TripInterruptionReason,
    enumName: 'TripInterruptionReason',
    example: TripInterruptionReason.EMERGENCY,
  })
  @IsEnum(TripInterruptionReason)
  @IsNotEmpty()
  reason: TripInterruptionReason;

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  note?: string;

  @ApiProperty({
    required: false,
    type: TripInterruptionCoordinatesDto,
  })
  @ValidateNested()
  @Type(() => TripInterruptionCoordinatesDto)
  @IsOptional()
  coordinates?: TripInterruptionCoordinatesDto | null;
}

export class ConfirmDriverTripInterruptionDto {
  @ApiProperty({ required: false })
  @IsUUID()
  @IsOptional()
  bookingId?: string;
}

export class DriverInterruptionFareQueryDto {
  @IsUUID()
  requestId: string;

  @IsUUID()
  bookingId: string;
}

export class DriverInterruptionDecisionDto extends DriverInterruptionFareQueryDto {
  @IsIn(['wait', 'stop'])
  decision: 'wait' | 'stop';

  @IsOptional()
  @IsUUID()
  quoteId?: string;
}

export class RejectTripInterruptionDto {
  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  reason?: string;

  @ApiProperty({ required: false })
  @IsUUID()
  @IsOptional()
  bookingId?: string;
}
