import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { CreditMutationDto, CreditPageDto } from '../shared/credit.dto';
import { CommerceTerms } from './commerce.policy';
import { IsDefined, IsUrl } from 'class-validator';

export class CommercePlanDto {
  @Matches(/^[a-z0-9-]{1,40}$/) id: string;
  @IsIn(['week', 'month']) period: 'week' | 'month';
  @IsInt() @Min(1) @Max(120) count: number;
}
export class CommerceTermsDto implements CommerceTerms {
  @IsIn(['commerce-v1']) version: 'commerce-v1';
  @IsString() @Matches(/^[1-9][0-9]{0,12}$/) acquisitionMinor: string;
  @IsString() @Matches(/^(0|[1-9][0-9]{0,12})$/) expensesMinor: string;
  @IsString() @Matches(/^(0|[1-9][0-9]{0,12})$/) marginMinor: string;
  @IsString() @Matches(/^(0|[1-9][0-9]{0,12})$/) minimumMarginMinor: string;
  @IsString() @Matches(/^(0|[1-9][0-9]{0,12})$/) depositMinor: string;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(12)
  @ValidateNested({ each: true })
  @Type(() => CommercePlanDto)
  plans: CommercePlanDto[];
}
export class CommerceMetadataDto {
  @IsString() @Length(3, 160) name: string;
  @IsString() @Length(3, 4000) description: string;
  @IsOptional() @IsString() @Length(1, 100) brand?: string;
  @IsOptional() @IsString() @Length(1, 100) model?: string;
  @IsOptional()
  @IsUrl({ protocols: ['https'], require_protocol: true })
  @Length(1, 2000)
  imageUrl?: string;
  @IsOptional() @IsString() @Length(0, 2000) specifications?: string;
  @IsOptional() @IsString() @Length(0, 2000) warranty?: string;
}
export class CommerceProductDto extends CreditMutationDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => CommerceMetadataDto)
  metadata?: CommerceMetadataDto;
  @IsInt() @Min(1) revision: number;
  @IsUUID() categoryId: string;
  @IsDefined()
  @ValidateNested()
  @Type(() => CommerceTermsDto)
  commerce: CommerceTermsDto;
}
export class CommerceCategoryDto extends CreditMutationDto {
  @Matches(/^[a-z0-9-]{3,60}$/) code: string;
  @IsString() @Length(2, 80) name: string;
  @IsIn(['equipment', 'phone', 'accessories', 'document', 'vehicle'])
  kind: string;
  @IsBoolean() enabled: boolean;
}
export class PurchaseQuoteDto {
  @IsIn(['cash', 'credit']) mode: 'cash' | 'credit';
  @IsOptional() @Matches(/^[a-z0-9-]{1,40}$/) planId?: string;
}
export class CommercePageDto extends CreditPageDto {
  @IsOptional() @IsUUID() categoryId?: string;
}
export class EarlySettlementDto extends CreditMutationDto {
  @Matches(/^[a-f0-9]{64}$/) quoteHash: string;
}
export class ChangePurchasePlanDto extends CreditMutationDto {
  @Matches(/^[a-z0-9-]{1,40}$/) planId: string;
  @IsInt() @Min(1) expectedVersion: number;
  @Matches(/^[1-9][0-9]{0,12}$/) expectedRemainingMinor: string;
}
