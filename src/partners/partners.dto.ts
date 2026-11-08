import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';

export class CreatePartnerOrganizationDto {
  @IsString() @MinLength(2) @MaxLength(160) displayName: string;
  @IsOptional() @IsString() @MinLength(2) @MaxLength(200) legalName?: string;
  @IsIn(['COMPANY', 'ASSOCIATION', 'CHURCH', 'INDIVIDUAL']) legalType: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(3) @IsIn(['FIELD_MARKETING', 'AFFILIATE', 'FLEET_OWNER'], { each: true }) partnerTypes: string[];
}

export class CreateFieldLeadDto {
  @IsString() @MinLength(2) @MaxLength(80) firstName: string;
  @IsString() @MinLength(2) @MaxLength(80) lastName: string;
  @Matches(/^\+?[0-9]{9,15}$/) phone: string;
  @IsString() @MinLength(2) @MaxLength(100) city: string;
}

export class CreateFieldTicketDto {
  @IsString() @MinLength(5) @MaxLength(120) subject: string;
  @IsString() @MinLength(10) @MaxLength(5000) message: string;
  @IsIn(['DRIVER', 'TECHNICAL', 'SAFETY', 'OTHER']) category: string;
  @IsOptional() @IsUUID() leadId?: string;
}

export class CreateFieldAgentDto {
  @Matches(/^\+?[0-9]{9,15}$/) phone: string;
  @IsString() @MinLength(2) @MaxLength(100) firstName: string;
  @IsString() @MinLength(2) @MaxLength(100) lastName: string;
  @IsOptional() @Matches(/^[0-9]{4}$/) initialPin?: string;
  @IsOptional() @IsIn(['FIELD_AGENT', 'FIELD_SUPERVISOR']) role?: string;
}

export class CreateFieldOrganizationDto {
  @IsString() @MinLength(2) @MaxLength(160) displayName: string;
}

export class SetFieldTargetDto {
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/) period: string;
  @IsInt() @Min(1) @Max(100000) goal: number;
}
