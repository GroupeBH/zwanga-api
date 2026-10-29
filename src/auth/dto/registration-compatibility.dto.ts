import { ApiHideProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, Matches } from 'class-validator';
import { ReferralAttributionDto } from '../../referrals/dto/referral.dto';

/** Compatibility with shipped clients, not an email identity assertion. */
export class RegistrationCompatibilityDto extends ReferralAttributionDto {
  @ApiPropertyOptional({
    description:
      'Preuve à usage unique renvoyée par users/phone/verify. Liée au numéro; ne remplace pas un jeton de connexion.',
  })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{43}$/)
  phoneVerificationToken?: string;

  // Older mobile forms send this unused field. Discard it during transformation:
  // phone registration does not use email; social email comes from the verified JWT.
  // IsOptional supplies whitelist metadata without allowing any other extra field.
  @ApiHideProperty()
  @Transform(() => undefined, { toClassOnly: true })
  @IsOptional()
  email?: never;
}
