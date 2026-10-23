import { IsIn, IsNumber, Max, Min } from 'class-validator';

/** Explicit consent to these amounts; never silently increase the debit. */
export class MixedCashPaymentDto {
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(99999999.99)
  expectedAmount: number;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(99999999.99)
  expectedTokenAmount: number;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(99999999.99)
  tokenQuantity: number;

  @IsIn(['CDF'])
  currency: string;
}
