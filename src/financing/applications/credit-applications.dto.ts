import {
  IsString,
  Matches,
  IsUUID,
  IsOptional,
  IsInt,
  Min,
  Max,
  IsIn,
  IsArray,
  ArrayMaxSize,
  ValidateNested,
  Length,
  IsBoolean,
} from 'class-validator';
import { CreditMutationDto } from '../shared/credit.dto';
import { Type } from 'class-transformer';

export class CreditEvidenceDto {
  @IsString() @Matches(/^[a-z0-9-]{1,60}$/) code: string;
  @IsUUID() attachmentId: string;
}

export class SubmitCreditApplicationDto extends CreditMutationDto {
  @IsUUID() productId: string;
  @IsOptional() @IsIn(['cash', 'credit']) mode?: 'cash' | 'credit';
  @IsOptional() @Matches(/^[a-z0-9-]{1,40}$/) planId?: string;
  @IsOptional() @Matches(/^[a-f0-9]{64}$/) quoteHash?: string;
  @IsOptional() @IsUUID() vehicleId?: string;
  @IsOptional() @IsUUID() caseId?: string;
  @IsString() @Matches(/^(0|[1-9][0-9]{0,12})$/) depositMinor: string;
  @IsInt() @Min(1) @Max(120) installments: number;
  @IsIn(['week', 'month']) period: 'week' | 'month';
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => CreditEvidenceDto)
  evidence: CreditEvidenceDto[];
  @IsString() @Length(0, 1000) notes: string;
}

export class ReviewCreditApplicationDto extends CreditMutationDto {
  @IsBoolean() approve: boolean;
  @IsString() @Length(6, 1000) reason: string;
}
