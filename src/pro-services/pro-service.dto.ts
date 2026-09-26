import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsDefined,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { CASE_STATES, SERVICE_CODES } from './pro-service.types';
import type { CaseState, ServiceCode } from './pro-service.types';
export class ApplicationDto {
  @IsString() @MinLength(3) @MaxLength(180) fullName: string;
  @IsString() @Matches(/^\+?[\d ()-]{8,20}$/) phone: string;
  @IsString() @MaxLength(180) vehicleDescription: string;
  @IsOptional() @IsString() @MaxLength(40) plate?: string;
  @IsArray()
  @ArrayMaxSize(10)
  @ArrayUnique()
  @IsString({ each: true })
  @MaxLength(60, { each: true })
  documents: string[];
  @IsString() @MaxLength(2000) description: string;
}
export class CreateServiceCaseDto {
  @IsIn([true]) contactConsent: boolean;
  @IsIn(SERVICE_CODES) serviceCode: ServiceCode;
  @IsUUID('4') submissionKey: string;
  @IsDefined()
  @ValidateNested()
  @Type(() => ApplicationDto)
  application: ApplicationDto;
}
export class ListServiceCasesDto {
  @IsOptional() @IsIn(CASE_STATES) status?: CaseState;
  @IsOptional() @IsString() @MaxLength(200) cursor?: string;
}
export class InstallmentDto {
  @IsISO8601({ strict: true }) dueDate: string;
  @IsInt() @Min(1) @Max(1_000_000_000) amountMinor: number;
}
export class RetainedDocumentDto {
  @IsString() @MinLength(2) @MaxLength(60) code: string;
  @IsString() @MinLength(2) @MaxLength(160) label: string;
}
export class QuoteServiceDto {
  @IsIn(['CDF', 'USD']) currency: 'CDF' | 'USD';
  @IsInt() @Min(1) @Max(1_000_000_000) totalMinor: number;
  @IsInt() @Min(0) @Max(1_000_000_000) depositMinor: number;
  @IsString() @MinLength(3) @MaxLength(200) providerName: string;
  @IsString() @MinLength(10) @MaxLength(3000) description: string;
  @IsISO8601({ strict: true }) validUntil: string;
  @IsArray()
  @ArrayMaxSize(52)
  @ValidateNested({ each: true })
  @Type(() => InstallmentDto)
  installments: InstallmentDto[];
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => RetainedDocumentDto)
  retainedDocuments: RetainedDocumentDto[];
}
export class AcceptServiceQuoteDto {
  @IsInt() @Min(1) quoteVersion: number;
  @IsIn([true]) consent: boolean;
}
export class CaseStatusDto {
  @IsIn(CASE_STATES) status: CaseState;
  @IsString() @MaxLength(2000) message: string;
}
export class ServiceLedgerDto {
  @IsIn(['deposit', 'funding', 'repayment']) kind:
    'deposit' | 'funding' | 'repayment';
  @IsInt() @Min(1) @Max(1_000_000_000) amountMinor: number;
  @IsString() @MinLength(6) @MaxLength(160) reference: string;
  @IsString() @MinLength(10) @MaxLength(2000) evidence: string;
}
export class CustodyDto {
  @IsIn(['receive', 'return']) action: 'receive' | 'return';
  @IsString() @MinLength(3) @MaxLength(300) receipt: string;
  @IsOptional() @IsString() @MaxLength(160) storageLocation?: string;
}
export class OfferingUpdateDto {
  @IsIn(['open', 'coming_soon', 'paused']) availability:
    'open' | 'coming_soon' | 'paused';
  @IsBoolean() legalValidated: boolean;
  @IsString() @MaxLength(80) termsVersion: string;
  @IsString() @MaxLength(20000) termsText: string;
  @IsString() @MaxLength(300) validationReference: string;
  @IsArray()
  @ArrayMaxSize(20)
  @ArrayUnique()
  @IsString({ each: true })
  @MaxLength(60, { each: true })
  custodyCodes: string[];
}
export class LinkServiceOwnerDto {
  @IsUUID('4') ownerId: string;
  @IsString() @MinLength(10) @MaxLength(2000) evidence: string;
}
