import { IsString, IsNotEmpty, IsNumber, IsOptional, IsEnum, Min, ValidateNested } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { BookingStatus } from '../entities/booking.entity';

class PassengerDestinationCoordinatesDto {
  @ApiProperty({ description: 'Latitude de la destination du passager', example: -4.3276 })
  @IsNumber()
  @IsNotEmpty()
  latitude: number;

  @ApiProperty({ description: 'Longitude de la destination du passager', example: 15.3136 })
  @IsNumber()
  @IsNotEmpty()
  longitude: number;
}

export class CreateBookingDto {
  @ApiProperty({ description: 'ID du trajet' })
  @IsString()
  @IsNotEmpty()
  tripId: string;

  @ApiProperty({ minimum: 1, description: 'Nombre de places à réserver' })
  @IsNumber()
  @Min(1)
  @IsNotEmpty()
  numberOfSeats: number;

  @ApiProperty({ 
    description: 'Destination du passager (optionnel - si non spécifié, utilise la destination du trajet)', 
    required: false,
    example: 'Aéroport de Kinshasa'
  })
  @IsString()
  @IsOptional()
  passengerDestination?: string;

  @ApiProperty({ 
    description: 'Coordonnées géographiques de la destination du passager (optionnel)', 
    required: false,
    type: PassengerDestinationCoordinatesDto
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => PassengerDestinationCoordinatesDto)
  passengerDestinationCoordinates?: PassengerDestinationCoordinatesDto;
}

export class UpdateBookingStatusDto {
  @ApiProperty({ enum: BookingStatus })
  @IsEnum(BookingStatus)
  @IsNotEmpty()
  status: BookingStatus;

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  rejectionReason?: string;
}

export class RejectBookingDto {
  @ApiProperty({ example: 'Le véhicule est déjà complet' })
  @IsString()
  @IsNotEmpty()
  reason: string;
}

