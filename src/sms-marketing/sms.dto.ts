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

export class SmsAudienceDto {
  @IsArray()
  @ArrayMaxSize(2)
  @ArrayUnique()
  @IsIn(['passenger', 'driver'], { each: true })
  roles: string[] = [];
  @IsBoolean() phoneVerifiedOnly = true;
  @IsOptional() @IsInt() @Min(1) @Max(365) activeWithinDays?: number | null;
  @IsOptional() @IsInt() @Min(1) @Max(365) inactiveForDays?: number | null;
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  @IsISO8601({ strict: true })
  signedUpFrom?: string | null;
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  @IsISO8601({ strict: true })
  signedUpTo?: string | null;
  @IsIn(['any', 'none', 'atLeastOne']) trips = 'any';
  @IsIn(['any', 'active', 'none']) proSubscription = 'any';
  @IsIn(['any', 'approved', 'pending']) kyc = 'any';
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10000)
  @Matches(/^\+[1-9]\d{6,14}$/, { each: true })
  phones?: string[] | null;
}
export class SmsEstimateDto {
  @IsDefined()
  @ValidateNested()
  @Type(() => SmsAudienceDto)
  audience: SmsAudienceDto;
  @IsString() @MinLength(1) @MaxLength(1000) message: string;
}
export class SmsDraftDto extends SmsEstimateDto {
  @IsString() @MinLength(1) @MaxLength(80) name: string;
}
export class SmsCreateDto extends SmsDraftDto {
  @IsUUID('4') requestId: string;
}
export class SmsRevisionDto {
  @IsInt() @Min(1) revision: number;
}
export class SmsUpdateDto extends SmsDraftDto {
  @IsInt() @Min(1) revision: number;
}
export class SmsRequestDto {
  @IsUUID('4') requestId: string;
}
export class SmsTestDto extends SmsRevisionDto {
  @IsUUID('4') requestId: string;
}
export class SmsLaunchDto extends SmsTestDto {
  @IsOptional() @IsISO8601({ strict: true }) scheduledAt: string | null = null;
  @IsInt() @Min(0) @Max(10000000) expectedRecipients: number;
}
export class SmsPageDto {
  @Type(() => Number) @IsInt() @Min(1) @Max(100000) page = 1;
  @Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 25;
  @IsOptional()
  @IsIn([
    'draft',
    'scheduled',
    'sending',
    'paused',
    'completed',
    'cancelled',
    'failed',
    'queued',
    'sent',
    'delivered',
    'skipped',
  ])
  status?: string;
  @IsOptional() @IsString() @MaxLength(100) search?: string;
}
export class SmsReasonDto {
  @IsString() @MinLength(1) @MaxLength(200) reason: string;
}
export class SmsOptOutDto extends SmsReasonDto {
  @Matches(/^\+[1-9]\d{6,14}$/) phone: string;
  @IsIn(['team', 'support']) source: 'team' | 'support';
}
