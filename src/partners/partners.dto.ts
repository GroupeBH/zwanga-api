import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength, ValidateIf } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

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
  @ApiPropertyOptional({ enum: ['existing', 'new'], description: 'Choix explicite du compte ; omission conservée pour les anciens clients.' })
  @IsOptional() @IsIn(['existing', 'new']) accountMode?: 'existing' | 'new';
  @ApiPropertyOptional({ description: 'Utilisateur sélectionné, sans modification de son profil ni de son PIN.' })
  @ValidateIf(o => o.accountMode === 'existing' || o.userId !== undefined)
  @IsUUID() userId?: string;
  @ValidateIf(o => (o.accountMode !== 'existing' && o.userId === undefined) || o.phone !== undefined)
  @Matches(/^\+?[0-9]{9,15}$/) phone?: string;
  @ValidateIf(o => (o.accountMode !== 'existing' && o.userId === undefined) || o.firstName !== undefined)
  @IsString() @MinLength(2) @MaxLength(100) firstName?: string;
  @ValidateIf(o => (o.accountMode !== 'existing' && o.userId === undefined) || o.lastName !== undefined)
  @IsString() @MinLength(2) @MaxLength(100) lastName?: string;
  @ValidateIf(o => o.accountMode === 'new' || o.initialPin !== undefined)
  @Matches(/^[0-9]{4}$/) initialPin?: string;
  @IsOptional() @IsIn(['FIELD_AGENT', 'FIELD_SUPERVISOR']) role?: string;
}

export class CreateFieldOrganizationDto {
  @IsString() @MinLength(2) @MaxLength(160) displayName: string;
}

export class SetFieldTargetDto {
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/) period: string;
  @IsInt() @Min(1) @Max(100000) goal: number;
}

export class SetFieldZonesDto {
  @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) @MinLength(2, { each: true }) @MaxLength(100, { each: true }) zones: string[];
}

export class SaveFieldDailyReportDto {
  @Matches(/^\d{4}-\d{2}-\d{2}$/) reportDate: string;
  @IsInt() @Min(0) @Max(100000) contactsCount: number;
  @IsOptional() @IsString() @MaxLength(100) zone?: string;
  @IsString() @MinLength(10) @MaxLength(5000) summary: string;
  @IsOptional() @IsString() @MaxLength(5000) obstacles?: string;
}
