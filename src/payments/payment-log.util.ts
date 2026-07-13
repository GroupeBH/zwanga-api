const SENSITIVE_KEY_PARTS = [
  'authorization',
  'bearer',
  'password',
  'secret',
  'token',
];

export function formatPaymentLogPayload(payload: unknown): string {
  try {
    return JSON.stringify(sanitizePaymentLogValue(payload));
  } catch {
    return String(payload);
  }
}

function sanitizePaymentLogValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizePaymentLogValue(item));
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  const sanitized: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(
    value as Record<string, unknown>,
  )) {
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, '');

    if (SENSITIVE_KEY_PARTS.some((part) => normalizedKey.includes(part))) {
      sanitized[key] = '[redacted]';
      continue;
    }

    if (normalizedKey.includes('phone')) {
      sanitized[key] = maskPaymentLogPhone(nestedValue);
      continue;
    }

    sanitized[key] = sanitizePaymentLogValue(nestedValue);
  }

  return sanitized;
}

function maskPaymentLogPhone(value: unknown): unknown {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return sanitizePaymentLogValue(value);
  }

  const digits = String(value).replace(/\D/g, '');
  if (digits.length <= 6) {
    return '***';
  }

  return `${digits.slice(0, 3)}***${digits.slice(-4)}`;
}
