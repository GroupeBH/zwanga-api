import {
  IsString,
  IsNotEmpty,
  IsNumber,
  IsDateString,
  IsOptional,
  IsEnum,
  Min,
  Max,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { TripStatus } from '../entities/trip.entity';

export class CreateTripDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  departureLocation: string;

  @ApiProperty()
  @IsNumber()
  @IsNotEmpty()
  departureLatitude: number;

  @ApiProperty()
  @IsNumber()
  @IsNotEmpty()
  departureLongitude: number;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  arrivalLocation: string;

  @ApiProperty()
  @IsNumber()
  @IsNotEmpty()
  arrivalLatitude: number;

  @ApiProperty()
  @IsNumber()
  @IsNotEmpty()
  arrivalLongitude: number;

  @ApiProperty()
  @IsDateString()
  @IsNotEmpty()
  departureDate: string;

  @ApiProperty({ minimum: 1 })
  @IsNumber()
  @Min(1)
  @IsNotEmpty()
  availableSeats: number;

  @ApiProperty({ minimum: 0 })
  @IsNumber()
  @Min(0)
  @IsNotEmpty()
  pricePerSeat: number;

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  description?: string;
}

export class SearchTripsDto {
  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  departureLocation?: string;

  @ApiProperty({ required: false })
  @IsNumber()
  @IsOptional()
  departureLatitude?: number;

  @ApiProperty({ required: false })
  @IsNumber()
  @IsOptional()
  departureLongitude?: number;

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  arrivalLocation?: string;

  @ApiProperty({ required: false })
  @IsNumber()
  @IsOptional()
  arrivalLatitude?: number;

  @ApiProperty({ required: false })
  @IsNumber()
  @IsOptional()
  arrivalLongitude?: number;

  @ApiProperty({ required: false })
  @IsDateString()
  @IsOptional()
  departureDate?: string;

  @ApiProperty({ required: false, minimum: 1 })
  @IsNumber()
  @Min(1)
  @IsOptional()
  minSeats?: number;

  @ApiProperty({ required: false, minimum: 0 })
  @IsNumber()
  @Min(0)
  @IsOptional()
  maxPrice?: number;
}

export class UpdateTripDto {
  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  departureLocation?: string;

  @ApiProperty({ required: false })
  @IsNumber()
  @IsOptional()
  departureLatitude?: number;

  @ApiProperty({ required: false })
  @IsNumber()
  @IsOptional()
  departureLongitude?: number;

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  arrivalLocation?: string;

  @ApiProperty({ required: false })
  @IsNumber()
  @IsOptional()
  arrivalLatitude?: number;

  @ApiProperty({ required: false })
  @IsNumber()
  @IsOptional()
  arrivalLongitude?: number;

  @ApiProperty({ required: false })
  @IsDateString()
  @IsOptional()
  departureDate?: string;

  @ApiProperty({ required: false, minimum: 1 })
  @IsNumber()
  @Min(1)
  @IsOptional()
  availableSeats?: number;

  @ApiProperty({ required: false, minimum: 0 })
  @IsNumber()
  @Min(0)
  @IsOptional()
  pricePerSeat?: number;

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiProperty({ required: false, enum: TripStatus })
  @IsEnum(TripStatus)
  @IsOptional()
  status?: TripStatus;
}

