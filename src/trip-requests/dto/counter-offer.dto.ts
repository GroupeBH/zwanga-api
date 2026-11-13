import { IsIn, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';

export class CounterOfferDto {
  /** Only a driver client able to answer a passenger price opts into bargaining. */
  @IsOptional()
  @IsIn([1])
  negotiationVersion?: 1;

  @IsInt()
  @Min(1)
  @Max(1000000)
  pricePerSeat: number;

  @IsUUID()
  vehicleId: string;
}
