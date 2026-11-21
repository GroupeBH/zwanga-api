import type { CreditPolicyRules } from './credit-policy.rules';
import {
  IsInt,
  Min,
  Max,
  IsString,
  Matches,
  IsBoolean,
  Length,
  IsDefined,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CreditRulesDto implements CreditPolicyRules {
  @IsInt() @Min(0) @Max(3650) minAccountDays: number;
  @IsInt() @Min(0) @Max(100000) minSettledTrips: number;
  @IsString() @Matches(/^(0|[1-9][0-9]{0,12})$/) minRevenueMinor: string;
  @IsInt() @Min(1) @Max(10) maxActiveCredits: number;
  @IsString() @Matches(/^[1-9][0-9]{0,12}$/) maxPrincipalMinor: string;
  @IsString() @Matches(/^(0|[1-9][0-9]{0,12})$/) newcomerLimitMinor: string;
  @IsInt() @Min(0) @Max(9999) minDepositBps: number;
  @IsInt() @Min(1) @Max(120) maxInstallments: number;
  @IsString() @Matches(/^(0|[1-9][0-9]{0,12})$/) fixedPerTripMinor: string;
  @IsInt() @Min(0) @Max(10000) netIncomeBps: number;
  @IsInt() @Min(0) @Max(10000) commissionShareBps: number;
  @IsBoolean() allowBeforeDelivery: boolean;
}

export class CreateCreditPolicyDto {
  @IsString() @Length(1, 40) version: string;
  @IsString() @Length(50, 12000) terms: string;
  @IsString() @Length(6, 160) legalReference: string;
  @IsDefined()
  @ValidateNested()
  @Type(() => CreditRulesDto)
  rules: CreditRulesDto;
}
