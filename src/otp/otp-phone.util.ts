import { BadRequestException } from '@nestjs/common';

/** Canonical international digits shared by the OTP provider and Redis key. */
export function normalizeOtpPhone(
  phone: string,
  defaultCountryCode = '+243',
): string {
  if (typeof phone !== 'string' || !phone.trim()) {
    throw new BadRequestException('Le numéro de téléphone est requis');
  }

  const countryCode = defaultCountryCode.replace(/\D/g, '');
  let normalized = phone.trim().replace(/[\s().-]/g, '');
  // An explicit prefix is authoritative, including for short foreign numbers.
  // Never interpret +32..., +352... or 00352... as a local RDC number.
  if (normalized.startsWith('+')) {
    normalized = normalized.slice(1);
  } else if (normalized.startsWith('00')) {
    normalized = normalized.slice(2);
  } else if (normalized.startsWith('0')) {
    normalized = `${countryCode}${normalized.slice(1)}`;
  } else if (
    countryCode &&
    !normalized.startsWith(countryCode) &&
    /^\d{8,10}$/.test(normalized)
  ) {
    normalized = `${countryCode}${normalized}`;
  }

  if (!/^[1-9]\d{6,14}$/.test(normalized)) {
    throw new BadRequestException('Numéro de téléphone international invalide');
  }
  return normalized;
}
