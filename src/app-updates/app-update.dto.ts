import { Equals, IsBoolean, IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { VERSION_PATTERN } from './app-update.policy';
import type { AppPlatform } from './app-update.policy';

export class AppVersionDto {
  @IsIn(['ios', 'android']) platform: AppPlatform;
  @IsString() @Matches(VERSION_PATTERN) @MaxLength(32) version: string;
  @IsString() @Matches(VERSION_PATTERN) @MaxLength(32) build: string;
}
export class AppUpdateClientDto extends AppVersionDto {
  @IsOptional() @IsString() @MaxLength(2048) pushToken?: string;
}
export class PublishAppReleaseDto extends AppVersionDto {
  @IsString() @MaxLength(500) notes: string;
  @IsBoolean() @Equals(true) storeAvailabilityConfirmed: boolean;
}
