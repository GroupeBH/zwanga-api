// Provider payloads are untrusted. Unknown fields and free text must not expose
// identities or secrets merely because a provider changes its payload shape.
const TECHNICAL_FIELDS = new Set([
  'id',
  'paymentid',
  'reference',
  'ordernumber',
  'providerreference',
  'clientreferenceid',
  'purpose',
  'relatedentitytype',
  'relatedentityid',
  'provider',
  'method',
  'type',
  'status',
  'statuscode',
  'providerstatus',
  'transactionstatus',
  'code',
  'errorcode',
  'currency',
  'amount',
  'paidat',
  'createdat',
  'updatedat',
  'timestamp',
]);
const CONTAINERS = new Set([
  'data',
  'result',
  'results',
  'transaction',
  'transactions',
  'response',
]);

export function formatPaymentLogPayload(payload: unknown): string {
  try {
    return JSON.stringify(sanitize(payload, new WeakSet(), 0));
  } catch {
    return '"[unavailable]"';
  } // Never fall back to the raw object.
}

function sanitize(
  value: unknown,
  seen: WeakSet<object>,
  depth: number,
): unknown {
  if (depth > 6) return '[truncated]';
  if (!value || typeof value !== 'object') return '[redacted]';
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value))
    return value.slice(0, 30).map((item) => sanitize(item, seen, depth + 1));
  const safe = Object.create(null) as Record<string, unknown>;
  for (const [key, item] of Object.entries(
    value as Record<string, unknown>,
  ).slice(0, 40)) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (TECHNICAL_FIELDS.has(normalized)) {
      safe[normalized] =
        typeof item === 'number' && Number.isFinite(item)
          ? item
          : item instanceof Date
            ? item.toISOString()
            : typeof item === 'string' &&
                /^[a-zA-Z0-9_.:+/-]{1,120}$/.test(item)
              ? item
              : item === null
                ? null
                : '[redacted]';
    } else if (CONTAINERS.has(normalized)) {
      safe[normalized] = sanitize(item, seen, depth + 1);
    } else {
      // Do not echo attacker-controlled field names, either.
      safe.redacted = true;
    }
  }
  return safe;
}
