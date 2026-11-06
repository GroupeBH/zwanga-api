import { IsInt, IsUUID, Max, Min } from 'class-validator';

export class CounterOfferDto {
  @IsInt()
  @Min(1)
  @Max(1000000)
  pricePerSeat: number;

  @IsUUID()
  vehicleId: string;
}
