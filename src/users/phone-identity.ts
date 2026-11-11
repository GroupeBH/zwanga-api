import { Raw } from 'typeorm';
import { normalizeOtpPhone } from '../otp/otp-phone.util';

/** Account identity and OTP destination must use the same RDC/international rules. */
export function canonicalAccountPhone(phone: string): string {
  return `+${normalizeOtpPhone(phone)}`;
}

/**
 * Ownership lookup, including legacy spellings and inactive accounts.
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

/**
 * Authentication ignores deactivated accounts, without releasing their phone
 * ownership or history. A suspended (but not deactivated) owner still counts;
 * the caller must enforce suspension and role restrictions on the selected user.
 * Match the ONLY remaining owner's exact stored phone, never an arbitrary row
 * sharing its canonical phone. The existing unique phone index identifies it.
 */
export function authAccountPhoneWhere(phone: string) {
  return Raw(
    (alias) => `${alias} = (
      SELECT CASE WHEN count(*) = 1 THEN min(phone_matches.phone) END
      FROM (
        SELECT phone_owner.phone FROM public.users phone_owner
        WHERE public.zwanga_canonical_phone(phone_owner.phone) = :accountPhone
          AND phone_owner."isActive" = true
          AND phone_owner.status <> 'inactive'
        LIMIT 2
      ) phone_matches
    )`,
    { accountPhone: canonicalAccountPhone(phone) },
  );
}
