import { IsInt, Max, Min } from 'class-validator';

export class NegotiatePriceDto {
  @IsInt()
  @Min(1)
  @Max(1000000)
  pricePerSeat: number;
}
