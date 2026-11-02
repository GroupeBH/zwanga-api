import { cert, type Credential, type ServiceAccount } from 'firebase-admin/app';
import { JWT } from 'google-auth-library';
import {
  FirebaseDeliveryError,
  firebaseRetryAfter,
} from './firebase-delivery-error';

const invalidators = new WeakMap<Credential, () => void>();
export function invalidateFirebaseCredential(credential: Credential) {
  invalidators.get(credential)?.();
}

/** Public Google auth client, with a cancellable transport (including response
 * body), no hidden retries and a single refresh shared by SDK and urgent sends. */
export function boundedFirebaseCredential(account: ServiceAccount): Credential {
  cert(account); // Preserve Firebase's service-account/key validation.
  const raw = account as ServiceAccount & {
    client_email?: string;
    private_key?: string;
  };
  let pending: ReturnType<Credential['getAccessToken']> | undefined;
  let cached: { access_token: string; expires_in: number } | undefined;
  let expires = 0,
    retryAt = 0;
  const credential: Credential = {
    getAccessToken() {
      if (cached && expires > Date.now() + 60_000)
        return Promise.resolve({
          ...cached,
          expires_in: Math.floor((expires - Date.now()) / 1000),
        });
      if (pending) return pending;
      if (Date.now() < retryAt)
        return Promise.reject(
          new FirebaseDeliveryError('FCM_AUTH_COOLDOWN', {
            code: 'messaging/auth-timeout',
            phase: 'auth',
            transient: true,
            retryAt,
          }),
        );
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5_000);
      const client = new JWT({
        email: raw.clientEmail ?? raw.client_email,
        key: raw.privateKey ?? raw.private_key,
        scopes: ['https://www.googleapis.com/auth/firebase.messaging'],
        transporterOptions: {
          signal: controller.signal,
          timeout: 5_000,
          retry: false,
        },
      });
      pending = client
        .authorize()
        .then((token) => {
          if (
            !token.access_token ||
            !token.expiry_date ||
            token.expiry_date <= Date.now()
          )
            throw new Error('Invalid OAuth response');
          expires = token.expiry_date;
          cached = {
            access_token: token.access_token,
            expires_in: Math.floor((expires - Date.now()) / 1000),
          };
          return cached;
        })
        .catch((error) => {
          const status = Number(error?.response?.status);
          retryAt = Math.max(
            Date.now() + 2_000,
            firebaseRetryAfter(
              error?.response?.headers?.get?.('retry-after') ?? null,
              status,
            ) ?? 0,
          );
          throw new FirebaseDeliveryError(
            controller.signal.aborted ? 'FCM_AUTH_TIMEOUT' : 'FCM_AUTH_FAILED',
            {
              code: controller.signal.aborted
                ? 'messaging/auth-timeout'
                : 'messaging/authentication-error',
              phase: 'auth',
              transient:
                controller.signal.aborted ||
                !status ||
                status === 429 ||
                status >= 500,
              timeoutMs: 5_000,
              ...(Number.isFinite(status) ? { httpStatus: status } : {}),
              retryAt,
            },
          );
        })
        .finally(() => {
          clearTimeout(timer);
          pending = undefined;
        });
      return pending;
    },
  };
  invalidators.set(credential, () => {
    cached = undefined;
    expires = 0;
  });
  return credential;
}
