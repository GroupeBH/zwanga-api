import { Raw } from 'typeorm';
import { normalizeOtpPhone } from '../otp/otp-phone.util';

/** Account identity and OTP destination must use the same RDC/international rules. */
export function canonicalAccountPhone(phone: string): string {
  return `+${normalizeOtpPhone(phone)}`;
}

/**
 * Indexed lookup, including legacy spellings. Authentication must never select
 * an arbitrary owner of a historical collision, even when one is inactive.
 * Registration uses the non-unique lookup; the database reservation is the final
 * authority and rolls back any attempted transfer of a conflicting identity.
 */
export function accountPhoneWhere(phone: string, unambiguous = true) {
  const canonical = canonicalAccountPhone(phone);
  return Raw(
    (alias) =>
      `public.zwanga_canonical_phone(${alias}) = :accountPhone${
        unambiguous
          ? ` AND (SELECT count(*) FROM (
      SELECT 1 FROM public.users phone_owner
      WHERE public.zwanga_canonical_phone(phone_owner.phone) = :accountPhone
      LIMIT 2
    ) phone_matches) = 1`
          : ''
      }`,
    { accountPhone: canonical },
  );
}
