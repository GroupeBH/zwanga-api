import {
  IsBoolean,
  IsDivisibleBy,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';
export class FleetPageDto {
  @IsOptional() @IsString() @Matches(/^[1-9]\d{0,17}$/) before?: string;
}
export class FleetPaymentDto {
  @IsUUID() mutationId: string;
  @IsInt() @Min(100) @Max(1e12) @IsDivisibleBy(100) amountMinor: number;
  @IsISO8601({ strict: true }) @Matches(/^\d{4}-\d{2}-\d{2}$/) paidOn: string;
  @IsString() @Length(3, 160) reference: string;
  @IsString() @Length(3, 100) periodLabel: string;
}
export class FleetPaymentDecisionDto {
  @IsBoolean() confirm: boolean;
  @ValidateIf((o) => !o.confirm || o.note !== undefined)
  @IsString()
  @Length(3, 300)
  note?: string;
}
