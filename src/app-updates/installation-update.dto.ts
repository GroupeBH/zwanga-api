import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  Min,
  MaxLength,
  MinLength,
} from 'class-validator';
import { AppVersionDto } from './app-update.dto';

export class InstallationUpdateDto extends AppVersionDto {
  @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER) sequence: number;
  @Transform(
    ({ obj, key }: { obj: Record<string, unknown>; key: string }) => obj[key],
  )
  @IsBoolean()
  enabled: boolean;
  @IsOptional() @IsString() @MinLength(16) @MaxLength(2048) pushToken?: string;
}
export class UpdateCampaignDto {
  @IsUUID('4') id: string;
  @IsString() @Matches(/^\d{1,18}$/) releaseId: string;
  @IsString() @MinLength(3) @MaxLength(90) title: string;
  @IsString() @MinLength(3) @MaxLength(300) body: string;
}
