import { generateKeyPairSync } from 'node:crypto';
import { JWT } from 'google-auth-library';
import {
  boundedFirebaseCredential,
  invalidateFirebaseCredential,
} from './firebase-credential';

describe('cancellable Firebase OAuth refresh', () => {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const account = {
    projectId: 'synthetic',
    clientEmail: 'test@example.invalid',
    privateKey,
  };
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });
  it('invalidates a rejected cached token without exposing credentials in errors', async () => {
    const auth = jest
      .spyOn(JWT.prototype, 'authorize')
      .mockResolvedValue({
        access_token: 'synthetic',
        expiry_date: Date.now() + 3600000,
      });
    const credential = boundedFirebaseCredential(account);
    await credential.getAccessToken();
    await credential.getAccessToken();
    expect(auth).toHaveBeenCalledTimes(1);
    invalidateFirebaseCredential(credential);
    await credential.getAccessToken();
    expect(auth).toHaveBeenCalledTimes(2);
    invalidateFirebaseCredential(credential);
    auth.mockRejectedValue({ message: 'SECRET', response: { status: 401 } });
    await expect(credential.getAccessToken()).rejects.toMatchObject({
      message: 'FCM_AUTH_FAILED',
      details: { transient: false, httpStatus: 401 },
    });
  });
  it('aborts the real Gaxios transport, coalesces callers and recovers with a fresh bounded client', async () => {
    jest.useFakeTimers();
    const original = JWT.prototype.authorize;
    let requests = 0,
      aborted = 0;
    // Only HTTP is simulated: JWT signing, Gaxios handling and signal propagation are real.
    jest.spyOn(JWT.prototype, 'authorize').mockImplementation(function (
      this: JWT,
    ) {
      this.transporter.defaults.fetchImplementation = (async (
        _url: unknown,
        options: any,
      ) => {
        requests++;
        if (requests === 1)
          return new Promise((_resolve, reject) => {
            options.signal.addEventListener(
              'abort',
              () => {
                aborted++;
                reject(new Error('aborted'));
              },
              { once: true },
            );
          });
        return new Response(
          JSON.stringify({
            access_token: 'synthetic-only',
            expires_in: 3600,
            token_type: 'Bearer',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }) as any;
      return original.call(this) as any;
    });
    const credential = boundedFirebaseCredential(account);
    const failures = Array.from({ length: 8 }, () =>
      expect(credential.getAccessToken()).rejects.toMatchObject({
        message: 'FCM_AUTH_TIMEOUT',
      }),
    );
    // Let signing/async request preparation run before advancing its deadline.
    for (let n = 0; n < 50; n++) await Promise.resolve();
    await jest.advanceTimersByTimeAsync(5000);
    await Promise.all(failures);
    expect(requests).toBe(1);
    expect(aborted).toBe(1);
    await expect(credential.getAccessToken()).rejects.toMatchObject({
      message: 'FCM_AUTH_COOLDOWN',
    });
    await jest.advanceTimersByTimeAsync(2001);
    await expect(credential.getAccessToken()).resolves.toMatchObject({
      access_token: 'synthetic-only',
    });
    await expect(credential.getAccessToken()).resolves.toMatchObject({
      access_token: 'synthetic-only',
    });
    expect(requests).toBe(2);
    expect(jest.getTimerCount()).toBe(0);
  });
});
