import {
  Equals,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
  IsArray, ArrayMaxSize, ValidateNested, Matches,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ASSET_KINDS, type AssetKind } from './asset-credit-products';

export class RepaymentPlanDto {
  @IsString() @Matches(/^[a-z0-9-]{1,32}$/) id: string;
  @IsInt() @Min(1) @Max(120) months: number;
}
export class OfferAssetCreditDto {
  @IsOptional() @IsArray() @ArrayMaxSize(6) @ValidateNested({ each: true }) @Type(() => RepaymentPlanDto)
  repaymentPlans?: RepaymentPlanDto[];
  @IsUUID() mutationId: string;
  @IsUUID() driverId: string;
  @IsIn(ASSET_KINDS) assetKind: AssetKind;
  @IsString() @Length(3, 120) label: string;
  @IsInt() @Min(100) @Max(1_000_000_000_000) principalMinor: number;
  @IsInt() @Min(1) @Max(9500) repaymentBps: number;
  @IsOptional() @IsInt() @Min(100) @Max(1_000_000_000_000) cashPriceMinor?: number;
  @IsOptional() @IsInt() @Min(0) @Max(1_000_000_000_000) creditFeeMinor?: number;
  @IsOptional() @IsInt() @Min(1) @Max(120) installmentCount?: number;
  @IsOptional() @IsIn(['week', 'month']) installmentPeriod?: 'week' | 'month';
  @IsString() @Length(50, 12000) terms: string;
  @IsString() @Length(3, 160) validationReference: string;
}
export class AssetConsentDto {
  @IsOptional() @IsString() @Matches(/^[a-z0-9-]{1,32}$/) selectedPlanId?: string;
  @IsOptional() @IsIn(['asset-credit-cost-v1']) costDisclosureVersion?: string;
  @IsBoolean() @Equals(true) consent: boolean;
  @IsString() @IsIn(['asset-credit-v1','asset-credit-v2']) policyVersion: string;
  @IsOptional() @IsInt() @Min(0) @Max(9500) expectedTotalRepaymentBps?: number;
}
export class ActivateAssetCreditDto {
  @IsString() @Length(3, 160) deliveryReference: string;
  @IsString() @Length(3, 160) assetReference: string;
}
export class RepayAssetCreditDto {
  @IsUUID() mutationId: string;
  @IsInt() @Min(10) @Max(1_000_000_000_000) amountMinor: number;
}
export class RequestAssetCreditDto {
  @IsIn(ASSET_KINDS) assetKind: AssetKind;
  @IsString() @Length(0, 1000) notes: string;
}
export class CreditRequestCommentDto {
  @IsString() @Length(0, 1000) notes: string;
}
