import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { STORE_PERMISSIONS, STORE_PROFILES } from './store.permissions';
import { StoreReplyDto } from './store.dto';
const raw = ({ obj, key }: { obj: any; key: string }) => obj[key];
const optional = (_: unknown, value: unknown) => value !== undefined;
export class StoreRevisionDto {
  @ApiProperty({ minimum: 0 })
  @Transform(raw)
  @IsInt()
  @Min(0)
  @Max(2147483646)
  revision: number;
}
export class StoreDraftDto extends StoreRevisionDto {
  @ApiProperty({ maxLength: 5970 })
  @Transform(raw)
  @IsString()
  @MaxLength(5970)
  text: string;
}
export class StoreApprovalDto extends StoreRevisionDto {
  @ApiPropertyOptional({
    description:
      'Super admin only: explicit reason for self-approval exception.',
  })
  @ValidateIf(optional)
  @Transform(raw)
  @IsString()
  @MaxLength(1000)
  overrideReason?: string;
}
export class StorePublishDto extends StoreRevisionDto {
  @ApiProperty() @Transform(raw) @IsUUID() requestId: string;
}
export class StoreReviewStateDto extends StoreRevisionDto {
  @ApiPropertyOptional({ enum: ['in_progress', 'closed'] })
  @ValidateIf(optional)
  @Transform(raw)
  @IsIn(['in_progress', 'closed'])
  status?: 'in_progress' | 'closed';
  @ApiPropertyOptional({ nullable: true })
  @ValidateIf((_, v) => v !== undefined && v !== null)
  @Transform(raw)
  @IsUUID()
  assigneeId?: string | null;
}
export class StoreGrantDto {
  @ApiProperty({ enum: [...Object.keys(STORE_PROFILES), 'custom'] })
  @Transform(raw)
  @IsIn([...Object.keys(STORE_PROFILES), 'custom'])
  profile: string;
  @ApiPropertyOptional({ enum: STORE_PERMISSIONS, isArray: true })
  @ValidateIf(optional)
  @Transform(raw)
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(30)
  @IsIn(STORE_PERMISSIONS, { each: true })
  permissions?: string[];
}
export class StoreIntegrationDto {
  @ApiPropertyOptional()
  @ValidateIf(optional)
  @Transform(raw)
  @IsBoolean()
  enabled?: boolean;
  @ApiPropertyOptional({ minimum: 15, maximum: 10080 })
  @ValidateIf(optional)
  @Transform(raw)
  @IsInt()
  @Min(15)
  @Max(10080)
  reviewsMinutes?: number;
  @ApiPropertyOptional({ minimum: 15, maximum: 10080 })
  @ValidateIf(optional)
  @Transform(raw)
  @IsInt()
  @Min(15)
  @Max(10080)
  catalogMinutes?: number;
  @ApiPropertyOptional({ minimum: 60, maximum: 10080 })
  @ValidateIf(optional)
  @Transform(raw)
  @IsInt()
  @Min(60)
  @Max(10080)
  reportsMinutes?: number;
  @ApiPropertyOptional({ minimum: 60, maximum: 10080 })
  @ValidateIf(optional)
  @Transform(raw)
  @IsInt()
  @Min(60)
  @Max(10080)
  vitalsMinutes?: number;
  @ApiPropertyOptional({ minimum: 60, maximum: 10080 })
  @ValidateIf(optional)
  @Transform(raw)
  @IsInt()
  @Min(60)
  @Max(10080)
  connectionMinutes?: number;
}
export const STORE_ALERT_TYPES = [
  'sync_failed',
  'data_unavailable',
  'negative_review',
  'unanswered_reviews',
  'metric_above',
  'metric_drop_percent',
  'version_changed',
] as const;
export class StoreAlertRuleDto {
  @ApiProperty() @Transform(raw) @IsString() @MaxLength(100) name: string;
  @ApiPropertyOptional({ enum: ['google', 'apple'], nullable: true })
  @ValidateIf((_, v) => v !== undefined && v !== null)
  @Transform(raw)
  @IsIn(['google', 'apple'])
  platform?: 'google' | 'apple' | null;
  @ApiProperty({ enum: STORE_ALERT_TYPES })
  @Transform(raw)
  @IsIn(STORE_ALERT_TYPES)
  type: string;
  @ApiPropertyOptional()
  @ValidateIf(optional)
  @Transform(raw)
  @IsString()
  @MaxLength(100)
  metric?: string;
  @ApiPropertyOptional()
  @ValidateIf(optional)
  @Transform(raw)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(1e12)
  threshold?: number;
  @ApiProperty({ enum: ['info', 'warning', 'critical'] })
  @Transform(raw)
  @IsIn(['info', 'warning', 'critical'])
  severity: string;
  @ApiProperty() @Transform(raw) @IsBoolean() enabled: boolean;
  @ApiProperty({
    description: 'Existing back-office user UUIDs',
    isArray: true,
  })
  @Transform(raw)
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(20)
  @IsUUID('all', { each: true })
  recipients: string[];
  @ApiProperty() @Transform(raw) @IsBoolean() email: boolean;
}
export class StoreAlertRulePatchDto extends PartialType(StoreAlertRuleDto, {
  skipNullProperties: false,
}) {}

export class StoreIncidentDto {
  @ApiProperty({
    enum: [
      'authentication',
      'apple_signin',
      'privacy',
      'location',
      'permissions',
      'bug',
      'listing',
      'compliance',
      'other',
    ],
  })
  @Transform(raw)
  @IsIn([
    'authentication',
    'apple_signin',
    'privacy',
    'location',
    'permissions',
    'bug',
    'listing',
    'compliance',
    'other',
  ])
  category: string;
  @ApiProperty() @Transform(raw) @IsString() @MaxLength(5000) note: string;
  @ApiPropertyOptional()
  @ValidateIf(optional)
  @Transform(raw)
  @IsString()
  @MaxLength(500)
  taskReference?: string;
  @ApiPropertyOptional()
  @ValidateIf(optional)
  @Transform(raw)
  @IsUUID()
  ownerId?: string;
}
