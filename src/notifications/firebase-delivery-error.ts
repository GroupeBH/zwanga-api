/** Safe diagnostics only: never retain the OAuth token, payload or provider body. */
export class FirebaseDeliveryError extends Error {
  constructor(
    message: string,
    readonly details: {
      code: string;
      phase: 'auth' | 'send';
      transient: boolean;
      timeoutMs?: number;
      httpStatus?: number;
      retryAt?: number;
    },
  ) {
    super(message);
    this.name = 'FirebaseDeliveryError';
  }

  get code(): string {
    return this.details.code;
  }
}

/** Keep the provider's lower bound; malformed quota values use FCM's 60s default. */
export function firebaseRetryAfter(value: string | null, status: number, now = Date.now()): number | undefined {
  const parsed = value && /^\d+$/.test(value.trim()) ? now + Number(value) * 1000 : value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) && parsed > now && parsed < 8.64e15
    ? Math.max(parsed, now + (status === 429 ? 60_000 : 0))
    : status === 429 ? now + 60_000 : undefined;
}
