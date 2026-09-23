import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsUUID,
  Max,
  Min,
} from 'class-validator';

export class TripSocketDto {
  @IsUUID('4')
  tripId: string;
}

export class BookingSocketDto {
  @IsUUID('4')
  bookingId: string;
}

export class DriverLocationSocketDto extends TripSocketDto {
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(2)
  @IsNumber({ allowNaN: false, allowInfinity: false }, { each: true })
  @Min(-180, { each: true })
  @Max(180, { each: true })
  coordinates: [number, number];

  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  accuracy?: number;

  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  speed?: number;

  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  heading?: number;

  @IsOptional()
  @IsISO8601({ strict: true })
  recordedAt?: string;
}

export class PassengerLocationSocketDto extends DriverLocationSocketDto {
  @IsUUID('4')
  bookingId: string;
}
