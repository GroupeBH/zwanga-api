import { Type } from 'class-transformer';
import { IsOptional, ValidateNested } from 'class-validator';
import { TripInterruptionCoordinatesDto } from '../../trips/dto/trip-interruption.dto';

/** Read-only preview: no interruption is created and no money is moved. */
export class PassengerInterruptionPreviewDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => TripInterruptionCoordinatesDto)
  coordinates?: TripInterruptionCoordinatesDto | null;
}
