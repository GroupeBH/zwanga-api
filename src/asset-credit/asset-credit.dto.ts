import {
  Equals,
  IsBoolean,
  IsIn,
  IsInt,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
} from 'class-validator';

export class OfferAssetCreditDto {
  @IsUUID() mutationId: string;
  @IsUUID() driverId: string;
  @IsIn(['phone', 'vehicle', 'equipment']) assetKind: string;
  @IsString() @Length(3, 120) label: string;
  @IsInt() @Min(100) @Max(1_000_000_000_000) principalMinor: number;
  @IsString() @Length(50, 12000) terms: string;
  @IsString() @Length(3, 160) validationReference: string;
}
export class AssetConsentDto {
  @IsBoolean() @Equals(true) consent: boolean;
  @IsString() @Equals('asset-credit-v1') policyVersion: string;
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
  @IsIn(['phone']) assetKind: 'phone';
  @IsString() @Length(0, 1000) notes: string;
}
