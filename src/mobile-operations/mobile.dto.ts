import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  Equals,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsObject,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { InstallationUpdateDto } from '../app-updates/installation-update.dto';
import { AppVersionDto } from '../app-updates/app-update.dto';
import { VERSION_PATTERN } from '../app-updates/app-update.policy';

const optional = (_: unknown, v: unknown) => v !== undefined;
const raw = ({ obj, key }: { obj: any; key: string }) => obj[key];
export const MOBILE_FEATURES = [
  'create_trip',
  'accept_request',
  'create_booking',
  'create_request',
] as const;
export const MOBILE_KINDS = [
  'information',
  'signup',
  'feature',
  'update',
  'maintenance',
  'operational',
  'marketing',
] as const;

export class MobilePreferencesDto {
  @ApiProperty() @Transform(raw) @IsBoolean() operational: boolean;
  @ApiProperty() @Transform(raw) @IsBoolean() updates: boolean;
  @ApiProperty() @Transform(raw) @IsBoolean() marketing: boolean;
}
export class MobileInstallationDto extends InstallationUpdateDto {
  @ApiProperty({ enum: ['production', 'staging', 'development'] })
  @IsIn(['production', 'staging', 'development'])
  environment: string;
  @ApiPropertyOptional()
  @ValidateIf(optional)
  @IsString()
  @MaxLength(80)
  osVersion?: string;
  @ApiPropertyOptional()
  @ValidateIf(optional)
  @IsString()
  @MaxLength(80)
  deviceCategory?: string;
  @ApiProperty({ enum: ['granted', 'provisional', 'denied', 'unknown'] })
  @IsIn(['granted', 'provisional', 'denied', 'unknown'])
  notificationPermission: string;
  @ApiProperty({ enum: ['fcm'] }) @Equals('fcm') pushProvider: 'fcm';
  @ApiProperty({ type: MobilePreferencesDto })
  @IsObject()
  @ValidateNested()
  @Type(() => MobilePreferencesDto)
  preferences: MobilePreferencesDto;
}
export class MobileSequenceDto {
  @ApiProperty({
    description:
      'Monotonically increasing per installation, independent of registration sequence',
  })
  @Transform(raw)
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  sequence: number;
}
export class MobileVersionCheckDto extends AppVersionDto {
  @ApiProperty({ enum: ['production', 'staging', 'development'] })
  @IsIn(['production', 'staging', 'development'])
  environment: string;
  @ApiPropertyOptional()
  @ValidateIf(optional)
  @IsUUID('4')
  installationId?: string;
}
export class MobilePolicyDto {
  @ApiProperty() @IsUUID('4') id: string;
  @ApiProperty({ enum: ['android', 'ios'] })
  @IsIn(['android', 'ios'])
  platform: 'android' | 'ios';
  @ApiProperty({ enum: ['production', 'staging', 'development'] })
  @IsIn(['production', 'staging', 'development'])
  environment: string;
  @ApiProperty() @IsString() @Matches(/^\d{1,18}$/) releaseId: string;
  @ApiProperty({ enum: ['NONE', 'OPTIONAL', 'RECOMMENDED', 'REQUIRED'] })
  @IsIn(['NONE', 'OPTIONAL', 'RECOMMENDED', 'REQUIRED'])
  mode: string;
  @ApiProperty()
  @IsString()
  @Matches(VERSION_PATTERN)
  @MaxLength(32)
  minimumBuild: string;
  @ApiPropertyOptional()
  @ValidateIf(optional)
  @IsString()
  @Matches(VERSION_PATTERN)
  @MaxLength(32)
  minimumVersion?: string;
  @ApiProperty() @IsString() @MinLength(3) @MaxLength(500) message: string;
  @ApiProperty() @IsString() @MaxLength(500) storeUrl: string;
  @ApiProperty({ enum: ['all', 'anonymous', 'linked'] })
  @IsIn(['all', 'anonymous', 'linked'])
  audience: string;
  @ApiProperty({ enum: MOBILE_FEATURES, isArray: true })
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(4)
  @IsIn(MOBILE_FEATURES, { each: true })
  blockedFeatures: string[];
  @ApiProperty() @IsDateString({ strict: true }) effectiveAt: string;
  @ApiPropertyOptional()
  @ValidateIf(optional)
  @IsDateString({ strict: true })
  expiresAt?: string;
  @ApiProperty({
    description:
      'Confirms the exact release is downloadable by the entire policy audience, not just staged rollout users',
  })
  @Transform(raw)
  @IsBoolean()
  availabilityConfirmed: boolean;
  @ApiProperty()
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  availabilityEvidence: string;
}
export class MobileRevisionDto {
  @ApiProperty()
  @Transform(raw)
  @IsInt()
  @Min(1)
  @Max(2147483647)
  revision: number;
  @ApiProperty() @Transform(raw) @Equals(true) confirmed: boolean;
}
export class MobilePolicyEditDto extends MobilePolicyDto {
  @ApiProperty()
  @Transform(raw)
  @IsInt()
  @Min(1)
  @Max(2147483647)
  revision: number;
}
export class MobileAudienceDto {
  @ApiPropertyOptional({ enum: ['android', 'ios'] })
  @ValidateIf(optional)
  @IsIn(['android', 'ios'])
  platform?: 'android' | 'ios';
  @ApiProperty({ enum: ['production', 'staging', 'development'] })
  @IsIn(['production', 'staging', 'development'])
  environment: string;
  @ApiProperty({ enum: ['all', 'anonymous', 'linked', 'driver', 'passenger'] })
  @IsIn(['all', 'anonymous', 'linked', 'driver', 'passenger'])
  population: string;
  @ApiPropertyOptional()
  @ValidateIf(optional)
  @IsString()
  @Matches(VERSION_PATTERN)
  @MaxLength(32)
  belowBuild?: string;
  @ApiPropertyOptional()
  @ValidateIf(optional)
  @Transform(raw)
  @IsInt()
  @Min(1)
  @Max(365)
  inactiveDays?: number;
}
export class MobileCampaignDto {
  @ApiProperty() @IsUUID('4') id: string;
  @ApiProperty() @IsString() @MinLength(3) @MaxLength(90) title: string;
  @ApiProperty() @IsString() @MinLength(3) @MaxLength(300) body: string;
  @ApiProperty({ enum: MOBILE_KINDS }) @IsIn(MOBILE_KINDS) kind: string;
  @ApiProperty({ type: MobileAudienceDto })
  @IsObject()
  @ValidateNested()
  @Type(() => MobileAudienceDto)
  audience: MobileAudienceDto;
  @ApiProperty() @IsDateString({ strict: true }) expiresAt: string;
}
export class MobileCampaignEditDto extends MobileCampaignDto {
  @ApiProperty()
  @Transform(raw)
  @IsInt()
  @Min(1)
  @Max(2147483647)
  revision: number;
}
export class MobileLaunchDto extends MobileRevisionDto {
  @ApiPropertyOptional()
  @ValidateIf(optional)
  @IsDateString({ strict: true })
  scheduledAt?: string;
}
export class MobilePageDto {
  @ApiPropertyOptional({ default: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10000)
  page = 1;
  @ApiPropertyOptional({ default: 25 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 25;
  @ApiPropertyOptional({ enum: ['android', 'ios'] })
  @ValidateIf(optional)
  @IsIn(['android', 'ios'])
  platform?: 'android' | 'ios';
  @ApiPropertyOptional()
  @ValidateIf(optional)
  @IsString()
  @Matches(VERSION_PATTERN)
  @MaxLength(32)
  version?: string;
  @ApiPropertyOptional({ enum: ['all', 'anonymous', 'linked'] })
  @ValidateIf(optional)
  @IsIn(['all', 'anonymous', 'linked'])
  population?: string;
  @ApiPropertyOptional({ enum: ['yes', 'no'] })
  @ValidateIf(optional)
  @IsIn(['yes', 'no'])
  reachable?: string;
  @ApiPropertyOptional()
  @ValidateIf(optional)
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  @IsDateString({ strict: true })
  from?: string;
  @ApiPropertyOptional()
  @ValidateIf(optional)
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  @IsDateString({ strict: true })
  to?: string;
}
export class MobileInstallationPageDto extends MobilePageDto {
  @ApiPropertyOptional({ enum: ['production', 'staging', 'development'] })
  @ValidateIf(optional)
  @IsIn(['production', 'staging', 'development'])
  environment?: string;
}
export class MobileResolutionDto {
  @ApiProperty() @IsString() @MinLength(5) @MaxLength(500) resolution: string;
}
