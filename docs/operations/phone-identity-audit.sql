-- Run only on an explicitly selected database, AFTER CanonicalPhoneIdentity.
-- Read-only; no full phone, name, PIN, OTP, token or financial data is returned.
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '10s';

SELECT count(*) AS collision_groups
FROM (
  SELECT public.zwanga_canonical_phone(phone)
  FROM public.users
  WHERE public.zwanga_canonical_phone(phone) IS NOT NULL
  GROUP BY public.zwanga_canonical_phone(phone) HAVING count(*) > 1
) collisions;

SELECT min(id::text) AS group_reference,
  '…' || right(public.zwanga_canonical_phone(phone), 4) AS masked_phone,
  count(*) AS accounts,
  jsonb_agg(jsonb_build_object(
    'id', id, 'role', role, 'status', status, 'isActive', "isActive",
    'format', CASE WHEN phone LIKE '+%' THEN 'international_plus'
      WHEN phone LIKE '00%' THEN 'international_00'
      WHEN phone LIKE '0%' THEN 'local' ELSE 'other' END
  ) ORDER BY id) AS members
FROM public.users
WHERE public.zwanga_canonical_phone(phone) IS NOT NULL
GROUP BY public.zwanga_canonical_phone(phone)
HAVING count(*) > 1
ORDER BY min(id::text)
LIMIT 200;

SELECT count(*) AS malformed_legacy_numbers
FROM public.users WHERE phone IS NOT NULL AND public.zwanga_canonical_phone(phone) IS NULL;

SELECT count(*) AS identities_reserved_for_review
FROM public.user_phone_identities WHERE "userId" IS NULL;
ROLLBACK;
