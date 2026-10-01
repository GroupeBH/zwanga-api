import { BadRequestException } from '@nestjs/common';

/** Canonical international digits shared by the OTP provider and Redis key. */
export function normalizeOtpPhone(
  phone: string,
  defaultCountryCode = '+243',
): string {
  if (!phone || !phone.trim()) {
    throw new BadRequestException('Le numéro de téléphone est requis');
  }

  const countryCode = defaultCountryCode.replace(/\D/g, '');
  let normalized = phone.trim().replace(/[\s().-]/g, '');
  if (normalized.startsWith('+')) normalized = normalized.slice(1);
  if (normalized.startsWith('00')) normalized = normalized.slice(2);

  if (normalized.startsWith('0')) {
    normalized = `${countryCode}${normalized.slice(1)}`;
  } else if (
    countryCode &&
    !normalized.startsWith(countryCode) &&
    /^\d{8,10}$/.test(normalized)
  ) {
    normalized = `${countryCode}${normalized}`;
  }

  if (!/^\d{8,15}$/.test(normalized)) {
    throw new BadRequestException('Numéro de téléphone international invalide');
  }
  return normalized;
}
