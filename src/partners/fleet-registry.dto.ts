import {
  IsBoolean,
  IsIn,
  IsInt,
  IsString,
  IsUUID,
  IsOptional,
  ValidateIf,
  IsDivisibleBy,
  Length,
  Max,
  Min,
} from 'class-validator';
export class FleetRegisterDto {
  @IsString() @Length(3, 30) plate: string;
  @IsString() @Length(2, 80) brand: string;
  @IsString() @Length(1, 80) model: string;
  @IsString() @Length(2, 50) color: string;
  @IsInt() @Min(1) @Max(60) seats: number;
}
export class FleetAssignDto {
  @IsUUID() driverId: string;
  @IsString() @Length(20, 6000) terms: string;
  @ValidateIf(
    (o) => o.periodicAmountMinor !== undefined || o.paymentPeriod !== undefined,
  )
  @IsInt()
  @Min(100)
  @Max(1e12)
  @IsDivisibleBy(100)
  periodicAmountMinor?: number;
  @ValidateIf(
    (o) => o.periodicAmountMinor !== undefined || o.paymentPeriod !== undefined,
  )
  @IsIn(['DAILY', 'WEEKLY', 'MONTHLY'])
  paymentPeriod?: 'DAILY' | 'WEEKLY' | 'MONTHLY';
}
export class FleetDecisionDto {
  @IsBoolean() accept: boolean;
  @IsOptional() @IsIn([true]) paymentTermsConfirmed?: true;
}
export class FleetReviewDto {
  @IsUUID() appVehicleId: string;
  @IsString() @Length(3, 200) verificationReference: string;
}
export class FleetStateDto {
  @IsIn(['AVAILABLE', 'PAUSED']) status: 'AVAILABLE' | 'PAUSED';
}
