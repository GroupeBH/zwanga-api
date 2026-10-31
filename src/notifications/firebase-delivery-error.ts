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
    },
  ) {
    super(message);
    this.name = 'FirebaseDeliveryError';
  }

  get code(): string {
    return this.details.code;
  }
}
