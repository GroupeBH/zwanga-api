import { ApiHideProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional } from 'class-validator';
import { ReferralAttributionDto } from '../../referrals/dto/referral.dto';

/** Compatibility with shipped clients, not an email identity assertion. */
export class RegistrationCompatibilityDto extends ReferralAttributionDto {
  // Older mobile forms send this unused field. Discard it during transformation:
  // phone registration does not use email; social email comes from the verified JWT.
  // IsOptional supplies whitelist metadata without allowing any other extra field.
  @ApiHideProperty()
  @Transform(() => undefined, { toClassOnly: true })
  @IsOptional()
  email?: never;
}
